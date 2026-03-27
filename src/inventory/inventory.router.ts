import { Router, Request, Response } from "express";
import * as Service from "./inventory.service";
import * as Types from "./inventory.types";
import * as SkuTypes from "../sku/sku.types";

const router = Router();

type ActivateProductRequest = {
	uid: Types.UUID;
	skuCode: string,
	manufacturing: Types.ManufacturingInfo
}

router.post("/generate-products", async function (req: Request, res: Response) {
	const nproducts = req.body.nproducts;
	if (!nproducts) {
		return res.status(400)
			.json({
				success: false,
				reason: "'nproducts' is a required field"
			});
	}
	const products = await Service.GenerateProducts(nproducts);
	return res.json({ 
		success: true,
		data: products
	});
})

router.post("/activate-product", async function (req: Request, res: Response) {
	const { uid, skuCode, manufacturing } = req.body as ActivateProductRequest;

	try {
		await Service.ActivateProduct(uid, skuCode, manufacturing);
		return res.json({
			success: true,
			message: "Product Activated",
		});
	} catch(err: any) {
		console.debug("Inventory: activate-product failed:",
					  { uid, skuCode, manufacturing },
					  err.message);
		return res.json({
			success: false,
			reason: err.message,
		})
	}
})

router.get("/:uid", async function (req: Request, res: Response) {
	const uid = req.params.uid as string;

	const product = await Service.XRayProduct(uid);
	if (!product) {
		// TODO: add proper error handling abstraction
		return res.status(404)
			.json({
				success: false,
				reason: `Product '${uid}' not found`,
			})
	}
	return res.json({
		success: true,
		data: product
	});
})

export default router;
