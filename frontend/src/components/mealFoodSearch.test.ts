import { expect, it } from 'vitest'
import { mealFoodSearch } from './mealFoodSearch'

it.each([
  ['金钱', '金钱', '小炒金钱蛋'],
  ['金钱200g', '金钱', '小炒金钱蛋200g'],
  ['金钱 0.5 份', '金钱', '小炒金钱蛋 0.5 份'],
  ['米饭200g + 金钱', '金钱', '米饭200g + 小炒金钱蛋'],
  ['米饭 200 g 金钱100克', '金钱', '米饭 200 g 小炒金钱蛋100克'],
  ['米饭200g，金钱', '金钱', '米饭200g，小炒金钱蛋'],
  ['土豆 牛肉', '土豆 牛肉', '小炒金钱蛋'],
  ['条状肉干(牛肉,黑胡椒)100g+金钱', '金钱', '条状肉干(牛肉,黑胡椒)100g+小炒金钱蛋'],
])('searches the current food and keeps other foods/amounts for %s', (text, query, selected) => {
  const search = mealFoodSearch(text)
  expect(search.query).toBe(query)
  expect(search.complete('小炒金钱蛋')).toBe(selected)
})
