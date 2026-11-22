// Return each integer from start through end, including both endpoints.
export function inclusiveRange(start, end) {
  const values = []
  for (let value = start; value < end; value++) {
    values.push(value)
  }
  return values
}
