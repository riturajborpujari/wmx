import { v4 as uuidv4 } from "uuid";
import * as Db from "../lib/database";
import * as Types from "./inventory.types";
import * as SkuService from "../sku/sku.service";

export async function ReserveInventory(
	inventoryUid: string,
	quantity: number,
) {
	const inventory = Db.GetCollection<Types.Inventory>("inventory");
	const inventoryRecord = await inventory.findOne({ uid: inventoryUid });
	if (!inventoryRecord) {
		throw new Error(
			`Reserve Inventory failed: Inventory '${inventoryUid}' not found`,
		);
	}

	let result: Types.Reservation;
	if (!inventoryRecord.sku.isSerialized) {
		result = await Db.RunTransaction(() => {
			return reserveNonSerializedInventory(inventoryRecord, quantity);
		});
	} else {
		result = await Db.RunTransaction(() => {
			return reserveSerializedInventory(inventoryRecord, quantity);
		});
	}

	return result;
}

export async function ReceiveInventory(
	data: Types.ReceiveInventoryObject,
): Promise<string> {
	const inventory = Db.GetCollection<Types.Inventory>("inventory");

	const sku = await SkuService.GetSkuByCode(data.skuCode);
	if (!sku) {
		throw new Error(
			`Receive Inventory failed: SKU '${data.skuCode}' not found`,
		);
	}
	const { skuCode, ...inventoryData } = data;
	const inventoryRecord = {
		uid: uuidv4(),
		...inventoryData,
		sku,
		quantity: sku.isSerialized ? 0 : inventoryData.quantity,
		reservedQuantity: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	const result = await inventory.insertOne(inventoryRecord);
	if (!result.insertedId) {
		throw new Error("Receive Inventory failed: Database error");
	}

	return inventoryRecord.uid;
}

export async function ReceiveInventoryItems(
	inventoryUid: string,
	itemRecords: Types.ReceiveInventoryItemObject[],
): Promise<string[]> {
	const inventory = Db.GetCollection<Types.Inventory>("inventory");
	const items = Db.GetCollection<Types.Item>("items");

	const inventoryRecord = await inventory.findOne({ uid: inventoryUid });
	if (!inventoryRecord) {
		throw new Error(
			`Recieve Inventory Items failed: Inventory '${inventoryUid}' not found`,
		);
	}
	if (!inventoryRecord.sku.isSerialized) {
		throw new Error(
			`Receive Inventory Items failed: Sku '${inventoryRecord.sku.code}' does not accept items`,
		);
	}

	const records = itemRecords.map((el) => ({
		...el,
		uid: uuidv4(),
		status: Types.ItemStatus.Fresh,
		createdAt: new Date(),
		updatedAt: new Date(),
	}));
	const result = await items.insertMany(records);
	if (result.insertedCount < itemRecords.length) {
		// TODO: Handle deletion of partial itemRecords
		throw new Error("Receive Inventory Items failed: Database error");
	}

	// TODO: ensure inventory quantity exactly refers to the items in collection
	// at all times
	await inventory.updateOne(
		{ uid: inventoryRecord.uid },
		{ $inc: { quantity: records.length } },
	);

	return records.map((el) => el.uid);
}

export async function XRayItem(query: string) {
	const items = Db.GetCollection<Types.Item>("items");

	const result = await items.aggregate([
		{ $match: { $or: [{ uid: query }, { clientUid: query }] } },
		{ $lookup: { from: "inventory", localField: "inventoryUid", foreignField: "uid", as: "inventory" } },
	]).toArray();

	if (!result.length) {
		throw new Error(`XRayItem failed: Item '${query}' not found`);
	}

	return result[0];
}

function buildReservationRecord(
	inventoryUid: string,
	quantity: number,
	itemUids: string[] = [],
): Types.Reservation {
	return {
		uid: uuidv4(),
		inventoryUid,
		itemUids,
		quantity,
		status: Types.ReservationStatus.Active,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

async function reserveSerializedInventory(
	inventoryRecord: Types.Inventory,
	quantity: number,
) {
	const inventory = Db.GetCollection<Types.Inventory>("inventory");
	const items = Db.GetCollection<Types.Item>("items");
	const reservation = Db.GetCollection<Types.Reservation>("reservations");

	// move value from 'quantity' to 'reservedQuantity'
	// while satisfying invariant `quantity >= 0`
	const result = await inventory.updateOne(
		{ uid: inventoryRecord.uid, quantity: { $gte: quantity } },
		{ $inc: { reservedQuantity: quantity, quantity: -quantity } },
	);
	if (!result.matchedCount) {
		throw new Error(
			`Reserve Inventory failed: Required quantity not available`,
		);
	}

	const criteria = {
		inventoryUid: inventoryRecord.uid,
		status: {
			$in: [Types.ItemStatus.Fresh, Types.ItemStatus.Returned],
		},
	};
	const availableItems = await items
		.find(criteria, {
			limit: quantity,
			projection: { uid: true },
		})
		.toArray();
	if (availableItems.length < quantity) {
		// TODO: Ensure control never reaches here
		console.error(
			`PANIC: Reserve Inventory failed: Inventory quantity - items count doesn't match`,
		);
		process.exit(-1);
	}

	const itemUids = availableItems.map((el) => el.uid);
	const invItemsReserveResult = await items.updateMany(
		{ uid: { $in: itemUids } },
		{ $set: { status: Types.ItemStatus.Reserved } },
	);
	if (!invItemsReserveResult.acknowledged) {
		throw new Error(`Reserve Inventory failed: Database Error`);
	}

	const reservationRecord = buildReservationRecord(
		inventoryRecord.uid,
		quantity,
		itemUids,
	);
	const reservationResult = await reservation.insertOne(reservationRecord);
	if (!reservationResult.insertedId) {
		throw new Error("Reserve Inventory failed: Database error");
	}
	return reservationRecord;
}

async function reserveNonSerializedInventory(
	inventoryRecord: Types.Inventory,
	quantity: number,
) {
	const inventory = Db.GetCollection<Types.Inventory>("inventory");
	const reservation = Db.GetCollection<Types.Reservation>("reservations");

	const result = await inventory.updateOne(
		{ uid: inventoryRecord.uid, quantity: { $gte: quantity } },
		{ $inc: { reservedQuantity: quantity, quantity: -quantity } },
	);
	if (!result.matchedCount) {
		throw new Error(
			`Reserve Inventory failed: Required quantity not available`,
		);
	}

	const reservationRecord = buildReservationRecord(
		inventoryRecord.uid,
		quantity,
	);
	const reservationResult = await reservation.insertOne(reservationRecord);
	if (!reservationResult.insertedId) {
		throw new Error("Reserve Inventory failed: Database error");
	}
	return reservationRecord;
}

// Reservations expires automatically after a certain period
// This method cancels them and replenishes stock quantity
export async cancelExpiredReservations() {
	const reservations = Db.GetCollection<Types.Reservation>("reservations");
	const inventory = Db.GetCollection<Types.Inventory>("inventory");
	const items = Db.GetCollection<Types.Items>("items");

	const expiryTimestamp = new Date(Date.now() - ReservationAutoCancellationPeriodMs)
	const expiredReservations = reservations.find({
		createdAt: { $lt: expiryTimestamp }
	});
	// TODO: handle reservation clean up and inventory stock replenishment
}

