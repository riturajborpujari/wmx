export type Sku = {
	code: string;
	name: string;
	description: string;
	unit: string;
	isSerialized: bool;
	meta: {
		[key: string]: any;
	};
};
