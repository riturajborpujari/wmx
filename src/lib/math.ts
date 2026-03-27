function combine<type T = number | string>(a: T, b: T): T {
	return a + b;
}

const output = combine<string>("hello", "world")
const n      = combine<number>(123, 123);
