import { v4 as uuidv4 } from "uuid";
import * as Db from "../lib/database";
import * as Types from "./inventory.types";
import * as SkuService from "../sku/sku.service";

export async function ReserveInventory(
	skuCode: string,
	batchId: string,
	quantity: number,
) {
	const inventory = Db.GetCollection<Types.Inventory>("inventory");
	const inventoryRecord = await inventory.findOne({
		"sku.code": skuCode,
		batchId,
	});
	if (!inventoryRecord) {
		throw new Error(
			`Reserve Inventory failed: No inventory found with Sku '${skuCode}' and batch '${batchId}'`,
		);
	}

	const sku = await SkuService.GetSkuByCode(skuCode);
	if (!sku) {
		throw new Error(`Reserve Inventory failed: SKU '${skuCode}' not found`);
	}

	let result: Types.Reservation;
	if (!sku.isSerialized) {
		result = await Db.RunTransaction(() => {
			return reserveNonSerializedInventory(inventoryRecord, quantity);
		})
	} else {
		result = await Db.RunTransaction(() => {
			return reserveSerializedInventory(inventoryRecord, quantity);
		})
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
		// TODO: ensure quantity matches number of items for serialized SKUs
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
	// TODO: ensure inventory quantity exactly refers to the items in collection
	// at all times
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
		sku: inventoryRecord.sku,
		uid: uuidv4(),
		createdAt: new Date(),
		updatedAt: new Date(),
	}));
	const result = await items.insertMany(records);
	if (result.insertedCount < itemRecords.length) {
		// TODO: Handle deletion of partial itemRecords
		throw new Error("Receive Inventory Items failed: Database error");
	}

	return records.map((el) => el.uid);
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

async function reserveSerializedInventory(inventoryRecord: Types.Inventory, quantity: number) {
	const inventory = Db.GetCollection<Types.Inventory>("inventory");
	const items = Db.GetCollection<Types.Item>("items");
	const reservation = Db.GetCollection<Types.Reservation>("reservations");

	// move value from 'quantity' to 'reservedQuantity'
	// while satisfying invariant `quantity >= 0`
	const result = await inventory.updateOne(
		{ uid: inventoryRecord.uid, quantity: { $gte: quantity } },
		{ $inc: { reservedQuantity: quantity }, $dec: { quantity: quantity } },
	);
	if (!result.matchedCount) {
		throw new Error(`Reserve Inventory failed: Required quantity not available`);
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
			`PANIC: Reserve Inventory failed: Inventory quantity - items count doesn't match`
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
	const reservationResult =
		await reservation.insertOne(reservationRecord);
	if (!reservationResult.insertedId) {
		throw new Error("Reserve Inventory failed: Database error");
	}
	return reservationRecord;
}

async function reserveNonSerializedInventory(inventoryRecord: Types.Inventory, quantity: number) {
	const inventory = Db.GetCollection<Types.Inventory>("inventory");
	const reservation = Db.GetCollection<Types.Reservation>("reservations");

	const result = await inventory.updateOne(
		{ uid: inventoryRecord.uid, quantity: { $gte: quantity } },
		{ $inc: { reservedQuantity: quantity }, $dec: { quantity: quantity } },
	);
	if (!result.matchedCount) {
		throw new Error(`Reserve Inventory failed: Required quantity not available`);
	}

	const reservationRecord = buildReservationRecord(
		inventoryRecord.uid,
		quantity,
	);
	const reservationResult =
		await reservation.insertOne(reservationRecord);
	if (!reservationResult.insertedId) {
		throw new Error("Reserve Inventory failed: Database error");
	}
	return reservationRecord;
}

