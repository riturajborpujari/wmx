import * as SkuTypes from "../sku/sku.types";

export type UUID = string;

export type Item = {
	uid: UUID;
	clientUid: string;
	inventoryUid: UUID;
	status: ItemStatus;
	reservationUid?: UUID;
	createdAt: Date;
	updatedAt: Date;
};

export enum ItemStatus {
	Available = 0,
	Reserved,
	Dispatched,
	Returned,
	Discarded,
	// Add more as required
}

export type Inventory = {
	uid: UUID;
	sku: SkuTypes.Sku;
	batchId: string;
	unit: string;
	mrp: {
		unit: string;
		value: string;
	};
	quantity: number;
	reservations: {
		[reservationUid: string]: number,
	};
	createdAt: Date;
	updatedAt: Date;
	expiryAt: Date;
};

export type Reservation = {
	uid: UUID;
	inventoryUid: UUID;
	quantity: number;
	status: ReservationStatus;
	invalidation?: {
		claimToken: UUID;
		claimedAt: Date;
	};
	createdAt: Date;
	updatedAt: Date;
};

export enum ReservationStatus {
	Created = 0,
	Active,
	Fulfilled,
	Cancelled,
	Invalidating,
	Invalidated,
}

export type ReceiveInventoryObject = Omit<
	Inventory,
	"sku" | "uid" | "createdAt" | "updatedAt"
> & { skuCode: string };

export type ReceiveInventoryItemObject = Omit<
	Item,
	"uid" | "createdAt" | "updatedAt" | "status"
>;
