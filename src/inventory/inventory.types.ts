import * as SkuTypes from "../sku/sku.types";

export type UUID = string;

export type Item = {
    uid: UUID;
    clientUid: string;
    sku: SkuTypes.Sku;
    inventoryUId: UUID;
    status: ItemStatus;
    createdAt: Date;
    updatedAt: Date;
};

export enum ItemStatus {
    Fresh = 0,
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
    reservedQuantity: number;
    createdAt: Date;
    updatedAt: Date;
    expiryAt: Date;
};

export type Reservation = {
	uid: UUID;
	inventoryUid: UUID;
	itemUids: UUID[];
	quantity: number;
	status: ReservationStatus;
	createdAt: Date;
	updatedAt: Date;
};

export enum ReservationStatus {
	Active = 1,
	Canceled,
	Expired,
};

export type ReceiveInventoryObject = Omit<
    Inventory,
    "sku" | "uid" | "createdAt" | "updatedAt" | "reservedQuantity"
> & { skuCode: string };

export type ReceiveInventoryItemObject = Omit<
    Item,
    "uid" | "createdAt" | "updatedAt"
>;
