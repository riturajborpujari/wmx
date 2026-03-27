import * as SkuTypes from "../sku/sku.types";

export type UUID = string;

export type Product = {
	uid           : UUID;
	manufacturing : ManufacturingInfo | null;
	sku           : SkuTypes.Sku | null;
	status		  : ProductStatus;
	// TODO: Operation History
	createdAt     : Date;
	updatedAt     : Date;
};

export enum ProductStatus {
	Fresh = 0,
	Activated,
	// Add more as required
}

export type ManufacturingInfo = {
	mfd     : Date;
	expiry  : Date;
	batchNo : string;
};
