import { v4 as uuidv4 } from "uuid";
import { AnyBulkWriteOperation, WithId } from "mongodb";
import * as Db from "../lib/database";
import * as Types from "./inventory.types";
import * as SkuService from "../sku/sku.service";

const ReservationInvalidationTimeoutMs = 10 * 60 * 1000; // 10 mins
const ReservationInvalidationBatchSize = 10;
const ReservationInvalidationCrashTimeoutMs =
	ReservationInvalidationTimeoutMs * 10;

/**
 * Inventory Service uses a eventually accurate model of operations
 * As such, periodic reconcillation jobs are required to keep
 * inventory in a accurate state
 */
export function InitScheduledJobs() {
	setInterval(
		invalidatePartialReservations,
		ReservationInvalidationTimeoutMs,
	);
	console.log(
		`INFO: Inventory: Schedulued Job: InvalidatePartialReservations: ${ReservationInvalidationTimeoutMs}ms`,
	);
	setInterval(invalidateOldReservations, ReservationInvalidationTimeoutMs);
	console.log(
		`INFO: Inventory: Scheduled Job: InvalidateOldReservations: ${ReservationInvalidationTimeoutMs}ms`,
	);
	setInterval(
		recoverCrashedInvalidations,
		ReservationInvalidationCrashTimeoutMs,
	);
	console.log(
		`INFO: Inventory: Scheduled Job: RecoverCrashedInvalidations: ${ReservationInvalidationCrashTimeoutMs}ms`,
	);
}

export async function ReserveInventory(inventoryUid: string, quantity: number) {
	const inventory = Db.GetCollection<Types.Inventory>("inventory");
	const inventoryRecord = await inventory.findOne({ uid: inventoryUid });
	if (!inventoryRecord) {
		throw new Error(
			`Reserve Inventory failed: Inventory '${inventoryUid}' not found`,
		);
	}

	if (!inventoryRecord.sku.isSerialized) {
		return reserveNonSerializedInventory(inventoryRecord, quantity);
	} else {
		return reserveSerializedInventory(inventoryRecord, quantity);
	}
}

export async function ReceiveInventory(
	data: Types.ReceiveInventoryObject,
): Promise<string> {
	const inventory = Db.GetCollection<Types.Inventory>("inventory");

	const { skuCode, ...inventoryData } = data;
	const sku = await SkuService.GetSkuByCode(skuCode);
	if (!sku) {
		throw new Error(
			`Receive Inventory failed: SKU '${data.skuCode}' not found`,
		);
	}
	const inventoryRecord: Types.Inventory = {
		uid: uuidv4(),
		...inventoryData,
		sku,
		quantity: sku.isSerialized ? 0 : inventoryData.quantity,
		reservations: {},
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	const result = await inventory.insertOne(inventoryRecord);
	if (!result.insertedId) {
		throw new Error(
			"Receive Inventory failed: Could not insert Inventory record",
		);
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

	const records: Types.Item[] = itemRecords.map((el) => ({
		...el,
		uid: uuidv4(),
		status: Types.ItemStatus.Available,
		createdAt: new Date(),
		updatedAt: new Date(),
	}));
	const result = await items.insertMany(records);
	if (result.insertedCount < itemRecords.length) {
		// TODO: Handle deletion of partial itemRecords
		throw new Error("Receive Inventory Items failed: Database error");
	}

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

function buildReservationRecord(
	inventoryUid: string,
	quantity: number,
): Types.Reservation {
	return {
		uid: uuidv4(),
		inventoryUid,
		quantity,
		status: Types.ReservationStatus.Created,
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
	const reservations = Db.GetCollection<Types.Reservation>("reservations");

	// Create a reservation record
	const reservationRecord = buildReservationRecord(
		inventoryRecord.uid,
		quantity,
	);
	const reservationInsResult =
		await reservations.insertOne(reservationRecord);
	if (!reservationInsResult.insertedId) {
		throw new Error(
			`Reserve Inventory failed: Could not create reservation record`,
		);
	}

	// Acquire Inventory
	const result = await inventory.updateOne(
		{ uid: inventoryRecord.uid, quantity: { $gte: quantity } },
		{
			$inc: { reservedQuantity: quantity, quantity: -quantity },
			$set: { [`reservations.${reservationRecord.uid}`]: quantity },
		},
	);
	if (!result.matchedCount) {
		throw new Error(
			`Reserve Inventory failed: Required quantity not available`,
		);
	}

	// Acquire Items
	const invItemsReserveResult = await items.updateMany(
		{
			inventoryUid: inventoryRecord.uid,
			status: Types.ItemStatus.Available,
		},
		{
			$set: {
				status: Types.ItemStatus.Reserved,
				reservationUid: reservationRecord.uid,
			},
		},
	);
	if (invItemsReserveResult.modifiedCount < quantity) {
		throw new Error("Reserve Inventory failed: Could not reserve Items");
	}

	// Activate Reservation
	const reservationUpdResult = await reservations.updateOne(
		{ uid: reservationRecord.uid },
		{ $set: { status: Types.ReservationStatus.Active } },
	);
	if (!reservationUpdResult.modifiedCount) {
		throw new Error("Reserve Inventory failed: Database error");
	}
	return reservationRecord;
}

async function reserveNonSerializedInventory(
	inventoryRecord: Types.Inventory,
	quantity: number,
) {
	const inventory = Db.GetCollection<Types.Inventory>("inventory");
	const reservations = Db.GetCollection<Types.Reservation>("reservations");

	// Create a reservation record
	const reservationRecord = buildReservationRecord(
		inventoryRecord.uid,
		quantity,
	);
	const reservationInsResult =
		await reservations.insertOne(reservationRecord);
	if (!reservationInsResult.insertedId) {
		throw new Error(
			`Reserve Inventory failed: Could not create reservation record`,
		);
	}

	// Acquire Inventory
	const result = await inventory.updateOne(
		{ uid: inventoryRecord.uid, quantity: { $gte: quantity } },
		{
			$inc: { reservedQuantity: quantity, quantity: -quantity },
			$set: { [`reservations.${reservationRecord.uid}`]: quantity },
		},
	);
	if (!result.matchedCount) {
		throw new Error(
			`Reserve Inventory failed: Required quantity not available`,
		);
	}

	// Activate Reservation
	const reservationUpdResult = await reservations.updateOne(
		{ uid: reservationRecord.uid },
		{ $set: { status: Types.ReservationStatus.Active } },
	);
	if (!reservationUpdResult.modifiedCount) {
		throw new Error("Reserve Inventory failed: Database error");
	}
	return reservationRecord;
}

/**
 * Server may crash while ReservingInventory. Thus, any inventory acquired
 * without fully making an `Active` reservation, needs to be released, and
 * reservation record invalidated.
 */
async function invalidatePartialReservations() {
	const claimToken = uuidv4();
	const claimCandidateUids = await findOldPartialReservationUids(
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
		await releaseInventory(claimedReservations);
		await releaseItems(claimedReservationUids);
		await markReservationsInvalidated(claimedReservationUids);
		console.log(
			`Inventory: ReleasePartialReservations succeeded: ${claimedReservationUids.join(",")}`,
		);
	} catch (err: any) {
		console.error(
			`Inventory: ReleasePartialReservations failed: ${claimedReservationUids.join(",")}: ${err.message}`,
		);
		console.debug(err);
	}
}

/**
 * Clears up `Active` Reservations which were created long ago.
 * This is needed to ensure, reservations which are not fulfilled
 * for a long time gets auto-invalidated
 */
async function invalidateOldReservations() {
	const claimToken = uuidv4();
	const claimCandidateUids = await findOldActiveReservationUids(
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
		await releaseInventory(claimedReservations);
		await releaseItems(claimedReservationUids);
		await markReservationsInvalidated(claimedReservationUids);
		console.log(
			`Inventory: InvalidateOldReservations succeeded: ${claimedReservationUids.join(",")}`,
		);
	} catch (err: any) {
		console.error(
			`Inventory: InvalidateOldReservations failed: ${claimedReservationUids.join(",")}: ${err.message}`,
		);
		console.debug(err);
	}
}

/**
 * `invalidateOldReservations()` might be running when(if) the server crashes.
 * This will cause reservations which were picked up but not fully invalidated
 * to revert back to `Active` status so that future run of this job can pick
 * them up again.
 */
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

function findOldPartialReservationUids(limit: number) {
	const reservations = Db.GetCollection<Types.Reservation>("reservations");
	const invalidationTimestamp = new Date(
		Date.now() - ReservationInvalidationTimeoutMs,
	);
	const pickupCriteria = {
		createdAt: { $lt: invalidationTimestamp },
		status: Types.ReservationStatus.Created,
		invalidation: { $exists: false },
	};
	return reservations
		.find(pickupCriteria, {
			limit,
			projection: { uid: true },
		})
		.map((el) => el.uid)
		.toArray();
}

function findOldActiveReservationUids(limit: number) {
	const reservations = Db.GetCollection<Types.Reservation>("reservations");
	const invalidationTimestamp = new Date(
		Date.now() - ReservationInvalidationTimeoutMs,
	);
	const pickupCriteria = {
		createdAt: { $lt: invalidationTimestamp },
		status: Types.ReservationStatus.Active,
		invalidation: { $exists: false },
	};
	return reservations
		.find(pickupCriteria, {
			limit,
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
				$inc: { quantity: el.quantity },
				$unset: { [`reservations.${el.uid}`]: true },
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
				status: Types.ItemStatus.Available,
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
