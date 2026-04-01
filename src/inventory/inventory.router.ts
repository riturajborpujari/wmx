import { Router, Request, Response } from "express";
import * as Service from "./inventory.service";
import * as Types from "./inventory.types";

const router = Router();

router.post("/", async function (req: Request, res: Response) {
	try {
		const payload = req.body as Types.ReceiveInventoryObject;
		const uid = await Service.ReceiveInventory(payload);
		res.status(201 /* Created */).json({
			success: true,
			data: uid,
		});
	} catch (err: any) {
		console.error("ReceiveInventory request failed:", err.message);
		res.status(500 /* FIXME: Add proper error handling */).json({
			success: false,
			reason: err.message,
		});
	}
});

router.post(
	"/:inventoryUid/items",
	async function (req: Request, res: Response) {
		try {
			const inventoryUid = req.params.inventoryUid as string;
			const itemClientUids = req.body as string[];
			const items = itemClientUids.map((el) => ({
				inventoryUid: inventoryUid,
				clientUid: el,
			}));
			const itemUids = await Service.ReceiveInventoryItems(
				inventoryUid,
				items,
			);
			return res.status(201).json({
				success: true,
				data: itemUids,
			});
		} catch (err: any) {
			console.error("ReceiveInventoryItems request failed:", err.message);
			return res.status(500).json({
				success: false,
				reason: err.mesage,
			});
		}
	},
);

router.post(
	"/:inventoryUid/reserve",
	async function (req: Request, res: Response) {
		try {
			const inventoryUid = req.params.inventoryUid as string;
			const quantity = req.body.quantity;
			if (typeof quantity !== "number" || quantity <= 0) {
				return res.status(400).json({
					success: false,
					reason: "quantity must be a positive number",
				});
			}
			const reservation = await Service.ReserveInventory(
				inventoryUid,
				quantity,
			);
			return res.status(200).json({
				success: true,
				data: reservation,
			});
		} catch (err: any) {
			console.error("ReserveInventory failed:", err.message);
			return res.status(500).json({
				success: false,
				data: err.message,
			});
		}
	},
);

router.get("/xray", async function (req: Request, res: Response) {
	try {
		const q = req.query.q as string;
		const result = await Service.XRayItem(q);
		return res.json({
			success: true,
			data: result,
		});
	} catch (err: any) {
		return res.status(404).json({
			success: false,
			reason: err.message,
		});
	}
});

export default router;
