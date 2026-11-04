// Keep the rest of a meal and its measured amount when selecting a suggestion.
export function mealFoodSearch(text: string) {
  let start = 0
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if ('(（'.includes(character)) depth++
    else if (')）'.includes(character)) depth = Math.max(0, depth - 1)
    else if (!depth && '+＋、,，;；\n'.includes(character)) start = index + 1
  }
  let prefix = text.slice(0, start)
  let food = text.slice(start)
  // A space after a measured food is also a meal separator; spaces within
  // a search such as “土豆 牛肉” remain available as multiple search keywords.
  const previous = food.match(/^(.*\d\s*(?:千克|公斤|公克|毫升|克|斤|两|kg|ml|g|个|只|根|片|份|碗)\s+)(\S.*)$/i)
  if (previous) { prefix += previous[1]; food = previous[2] }
  const leading = food.match(/^\s*/)?.[0] ?? ''
  prefix += leading; food = food.slice(leading.length)
  const amount = food.match(/\s*\d+(?:\.\d+)?\s*(?:千克|公斤|公克|毫升|克|斤|两|kg|ml|g|个|只|根|片|份|碗)\s*$/i)
  const suffix = amount?.[0] ?? ''
  const query = (amount ? food.slice(0, amount.index) : food).trim()
  return { query, complete: (name: string) => prefix + name + suffix }
}
