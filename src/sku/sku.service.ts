import * as Db from "../lib/database";
import * as Types from "./sku.types";

export async function CreateSku(record: Types.Sku) {
	const result = await getCollection().insertOne(record);
	if (!result.insertedId) {
		throw new Error("Sku Insert failed");
	}
}

export function GetSkuByCode(code: string): Promise<Types.Sku | null> {
	return getCollection().findOne({ code }, { projection: { _id: false }});
}

function getCollection() {
    return Db.GetCollection<Types.Sku>("skus");
}
