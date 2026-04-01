import { v4 as uuidv4 } from "uuid";
import { AnyBulkWriteOperation, WithId } from "mongodb";
import * as Db from "../lib/database";
import * as Types from "./inventory.types";
import * as SkuService from "../sku/sku.service";

const ReservationInvalidationTimeoutMs = 10 * 60 * 1000; // 10 mins
const ReservationInvalidationBatchSize = 10;
const ReservationInvalidationCrashTimeoutMs =
	ReservationInvalidationTimeoutMs * 10;

export async function ReserveInventory(inventoryUid: string, quantity: number) {
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

	const result = await items
		.aggregate([
			{ $match: { $or: [{ uid: query }, { clientUid: query }] } },
			{
				$lookup: {
					from: "inventory",
					localField: "inventoryUid",
					foreignField: "uid",
					as: "inventory",
				},
			},
		])
		.toArray();

	if (!result.length) {
		throw new Error(`XRayItem failed: Item '${query}' not found`);
	}

	return result[0];
}

export function InitScheduledJobs() {
	// TODO: Do we need handle jobs restart / stop?
	setInterval(invalidateOldReservations, ReservationInvalidationTimeoutMs);
	console.log(
		`Inventory Service: InvalidateOldReservations: Job Scheduled at interval ${ReservationInvalidationTimeoutMs}ms`,
	);
	setInterval(
		recoverCrashedInvalidations,
		ReservationInvalidationCrashTimeoutMs,
	);
	console.log(
		`Inventory Service: RecoverCrashedInvalidations: Job scheduled at interval ${ReservationInvalidationCrashTimeoutMs}ms`,
	);
}

function buildReservationRecord(
	inventoryUid: string,
	quantity: number,
): Types.Reservation {
	return {
		uid: uuidv4(),
		inventoryUid,
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
async function invalidateOldReservations() {
	const claimToken = uuidv4();
	const claimCandidateUids = await findCandidateUids(
		ReservationInvalidationBatchSize,
	);
	const claimedReservations = await claimReservations(
		claimCandidateUids,
		claimToken,
	);
	const claimedReservationUids = claimedReservations.map((el) => el.uid);
	console.debug(
		"DEBUG: Invalid Reservations:",
		claimedReservationUids.join(","),
	);

	try {
		await Db.RunTransaction(async () => {
			await releaseInventory(claimedReservations);
			await releaseItems(claimedReservationUids);
			await markReservationsInvalidated(claimedReservationUids);
		});
		console.log(
			`Inventory: InvalidateReservations succeeded: ${claimedReservationUids.join(",")}`,
		);
	} catch (err: any) {
		console.error(
			`Inventory: InvalidateReservations failed: ${claimedReservationUids.join(",")}: ${err.message}`,
		);
		console.debug(err);
	}
}

async function recoverCrashedInvalidations() {
	const reservations = Db.GetCollection<Types.Reservation>("reservations");
	const crashDetectionTimestamp = new Date(
		Date.now() - ReservationInvalidationCrashTimeoutMs,
	);
	await reservations.updateMany(
		{
			status: Types.ReservationStatus.Invalidating,
			updatedAt: { $lt: crashDetectionTimestamp },
		},
		{
			$set: {
				status: Types.ReservationStatus.Active,
				updatedAt: new Date(),
			},
		},
	);
}

function findCandidateUids(nMaxCandidates: number) {
	const reservations = Db.GetCollection<Types.Reservation>("reservations");
	const invalidationTimestamp = new Date(
		Date.now() - ReservationInvalidationTimeoutMs,
	);
	const pickupCriteria = {
		createdAt: { $lt: invalidationTimestamp },
		invalidation: { $exists: false },
	};
	return reservations
		.find(pickupCriteria, {
			limit: nMaxCandidates,
			projection: { uid: true },
		})
		.map((el) => el.uid)
		.toArray();
}

async function claimReservations(
	pickupCandidateUids: string[],
	claimToken: string,
): Promise<WithId<Types.Reservation>[]> {
	const reservations = Db.GetCollection<Types.Reservation>("reservations");
	const result = await reservations.updateMany(
		{
			uid: { $in: pickupCandidateUids },
			status: { $eq: Types.ReservationStatus.Active },
		},
		{
			$set: {
				status: Types.ReservationStatus.Invalidating,
				invalidation: { claimToken, claimedAt: new Date() },
			},
		},
	);
	if (result.modifiedCount == 0) {
		return [];
	}

	const criteria = {
		status: Types.ReservationStatus.Invalidating,
		"invalidation.claimToken": claimToken,
	};
	return reservations.find(criteria).toArray();
}

async function releaseInventory(invalidReservations: Types.Reservation[]) {
	const inventory = Db.GetCollection<Types.Inventory>("inventory");
	const inventoryReleaseOps =
		buildInventoryReleaseOperations(invalidReservations);
	const inventoryReleaseResult =
		await inventory.bulkWrite(inventoryReleaseOps);
	if (!inventoryReleaseResult.ok) {
		throw new Error(
			"releaseInventory failed: " +
				inventoryReleaseResult
					.getWriteErrors()
					.map((el) => el.errmsg)
					.join(","),
		);
	}
}

function buildInventoryReleaseOperations(
	invalidReservations: Types.Reservation[],
): AnyBulkWriteOperation<Types.Inventory>[] {
	return invalidReservations.map((el) => ({
		updateOne: {
			filter: { uid: el.inventoryUid },
			update: {
				$inc: {
					quantity: el.quantity,
					reservedQuantity: -el.quantity,
				},
				$set: { updatedAt: new Date() },
			},
		},
	}));
}

function releaseItems(reservationUids: string[]) {
	const items = Db.GetCollection<Types.Item>("items");
	return items.updateMany(
		{ reservationUid: { $in: reservationUids } },
		{
			$set: {
				status: Types.ItemStatus.Fresh,
				updatedAt: new Date(),
			},
			$unset: { reservationUid: true },
		},
	);
}

function markReservationsInvalidated(reservationUids: string[]) {
	const reservations = Db.GetCollection<Types.Reservation>("reservations");
	return reservations.updateMany(
		{ uid: { $in: reservationUids } },
		{
			$set: {
				status: Types.ReservationStatus.Invalidated,
				updatedAt: new Date(),
			},
			$unset: { invalidation: true },
		},
	);
}
