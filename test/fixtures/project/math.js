/**
 * Adds two numbers.
 * @param {number} a - first operand
 * @param {number} b - second operand
 * @returns {number} the sum
 */
export function add(a, b) {
  return a + b;
}

export class Calculator {
  total = 0;

  /** @param {number} n */
  push(n) {
    this.total = add(this.total, n);
    return this;
  }
}
