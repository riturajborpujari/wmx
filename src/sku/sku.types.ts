
export type Sku = {
	code		: string;
	name        : string;
	description : string;
	unit        : string;
	mrp         : {
		unit       : string;
		value      : number;
	};
}

