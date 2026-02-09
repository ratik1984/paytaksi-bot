import { Low } from 'lowdb'
import { JSONFile } from 'lowdb/node'
import path from 'path'

const dbFile = process.env.DB_FILE || path.join(process.cwd(), 'data.json')
const adapter = new JSONFile(dbFile)

export const db = new Low(adapter, {
  users: {},
  rides: {},
  settings: {
    baseFare: 1.0,
    perKm: 0.6,
    perMin: 0.1,
    currency: 'AZN'
  }
})

export async function initDb() {
  await db.read()
  // Ensure shape
  db.data ||= {}
  db.data.users ||= {}
  db.data.rides ||= {}
  db.data.settings ||= { baseFare: 1.0, perKm: 0.6, perMin: 0.1, currency: 'AZN' }
  await db.write()
}

export async function save() {
  await db.write()
}
