import { add, Calculator } from './math.js';

const result = add(1, 2);
const calc = new Calculator();
calc.push(result);
console.log(add(result, 3));
