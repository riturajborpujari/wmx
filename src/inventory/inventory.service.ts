import { v4 } from "uuid";
import * as Db from "../lib/database";
import * as Types from "./inventory.types";
import * as SkuService from "../sku/sku.service";

/**
 * Generate Fresh products in database.
 * @param {number} nproducts the number of products required
 * @return {Promise<string[]>} the UID list of the products generated
 */
export async function GenerateProducts(nproducts: number): Promise<string[]> {
	const products = createProductRecords(nproducts);

	const collection = Db.GetCollection<Types.Product>("products");
	const result = await collection.insertMany(products);

	if (!result.insertedCount) {
		throw new Error("Products Insert failed");
	}
	return products.map(el => el.uid);
}

/**
 * Activate Product with Sku and Manufacturing Info
 * @param {Types.UUID} uid the UID of the product to Activate
 * @param {string}  skuCode the code of the Sku to Activate with
 * @param {Types.ManufacturingInfo} manufacturing the manufacturing info to Activate with
 */
export async function ActivateProduct(uid: Types.UUID, skuCode: string, manufacturing: Types.ManufacturingInfo): Promise<void> {
	const collection = Db.GetCollection<Types.Product>("products");

	const product = await collection.findOne({ uid });
	if (!product) {
		throw new Error("Product not found");
	}
	if (product.manufacturing) {
		throw new Error("Product already Activated");
	}

	const sku = await SkuService.GetSkuByCode(skuCode);
	if (!sku) {
		throw new Error(`SKU '${skuCode}' doesn't exist`);
	}

	// TODO: type checking on `manufacturing`
	const result = await collection.updateOne({ uid }, {
		$set: {
			sku,
			manufacturing,
			status: Types.ProductStatus.Activated
		},
	});
	if (!result.modifiedCount) {
		throw new Error("Database error");
	}
}

/**
 * XRay product - gets product info
 * @param {Types.UUID} uid the UID of the Product to XRay
 * @return {Promise<Types.Product | null>} the product info
 */
export function XRayProduct(uid: Types.UUID): Promise<Types.Product | null> {
	const collection = Db.GetCollection<Types.Product>("products");
	return collection.findOne({ uid });
}

function createProductRecords(nproducts: number): Types.Product[] {
	let products: Types.Product[] = [];

	for (let i = 0; i < nproducts; ++i) {
		products.push({
			uid           : v4(),
			manufacturing : null,
			sku           : null,
			status		  : Types.ProductStatus.Fresh,
			createdAt     : new Date(),
			updatedAt     : new Date(),
		});
	}
	return products;
}
