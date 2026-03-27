import { Router, Request, Response } from "express";
import * as Service from "./sku.service";
import * as Types from "./sku.types";

const router = Router();

router.get("/:skuCode", async (req: Request, res: Response) => {
	const skuCode = req.params.skuCode as string;
	const sku = await Service.GetSkuByCode(skuCode);
	if (!sku) {
		return res.status(404)
		    .json({
				success: false,
				reason: `SKU '${skuCode}' not found`
			})
	}
	return res.json({
		success: true,
		data: sku
	});
})

router.post("/", async (req: Request, res: Response) => {
	const record = req.body as Types.Sku;
	try {
		await Service.CreateSku(record);
		return res.json({
			success: true,
			message: "Sku Created"
		})
	} catch(err: any) {
		console.error("ERROR: Sku Create failed:", err.message);
		return res.json({
			success: false,
			reason: err.message
		});
	}
})

export default router;
