export default class PocketBaseInterface {
  constructor(collection_name) {
      this.api_url = `http://${process.env.POCKETBASE_HOST}/api/collections/${collection_name}/records`
      this.fetch_headers = { "Referer": process.env.NODE_NAME, 'Content-Type': 'application/json' }
  }
  /**
   * @param {String} identity can be an email or unsername
   * @param {String} password
   */
  async auth(identity, password) {
      const response = await fetch(`http://${process.env.POCKETBASE_HOST}/api/collections/users/auth-with-password`, { headers: this.fetch_headers, method: 'POST', body: JSON.stringify({ identity, password }) })

      if (response.ok)
          try {
              this.fetch_headers["Authorization"] = (await response.json()).token
              return
          }
          catch (_) { /**💡 All api responses are expected to return json */ }
      throw await response.json()
  }

  
  /**
   * @param {Object} body
   */
  async create(body) {
      if (typeof body.id !== 'undefined' && (typeof body.id !== 'string' || body.id.length !== 15)) body.id = body.id.toString().padStart(15, 0)
      const response = await fetch(`${this.api_url}`, { headers: this.fetch_headers, method: 'POST', body: JSON.stringify(body) })
      if (!response.ok) throw await response.json()
  }
  /**
   * @param {Number||String} id
   * @param {Object} body
   */
  async update(id, body) {
      if (typeof id !== 'string' || id.length !== 15) id = id.toString().padStart(15, 0)
      const response = await fetch(`${this.api_url}/${id}`, { headers: this.fetch_headers, method: 'PATCH', body: JSON.stringify(body) })
      if (!response.ok) throw await response.json()
  }


  /**
   * @param {Number||String} id
   * @argument {String} keys
   * @argument {String} expand
   */
  async getOne(id, args = {}) {
      if (typeof id !== 'string' || id.length !== 15) id = id.toString().padStart(15, 0)

      const response = await fetch(`${this.api_url}/${id}?${this._serializeQueryParams({ expand: args.expand })}`, { headers: this.fetch_headers })
      if (response.ok)
          try {
              return this._keysFilter(await response.json(), args.keys)
          }
          catch (_) { /**💡 All api responses are expected to return json */ }
      throw { url: response.url, status: response.status }
  }

  /**
   * @argument {String} filter
   * @argument {String} sort
   * @argument {String} keys
   * @argument {String} expand
   * @argument {String} page_index
   * @param {Number} page_length
   */
  async getList(args = {}, page_length = 50) {
      if (args.page_index) {
          const response = await fetch(`${this.api_url}?page=${args.page_index}&perPage=${page_length}${this._serializeQueryParams({ filter: args.filter, sort: args.sort, expand: args.expand })}`, { headers: this.fetch_headers })
          if (response.ok)
              try {
                  const records = (await response.json()).items
                  return records.map(record => this._keysFilter(record, args.keys))
              }
              catch (_) { /**💡 All api responses are expected to return json */ }
          throw { url: response.url, status: response.status }
      }

      let [total, page_count] = this._biggestDivisor(page_length)
      if (page_count > 800) console.log("💥 More than 800 // requests 💥")
      let reqs = new Array(page_count)
      for (let i = 1; i <= page_count; i++) {
          reqs[i - 1] = (new Promise(async (resolve, reject) => {
              const url = `${this.api_url}?page=${i}&perPage=${total}${this._serializeQueryParams({ filter: args.filter, sort: args.sort, expand: args.expand })}`
              let response = await fetch(url, { headers: this.fetch_headers })
              if (response.ok)
                  try {
                      const records = (await response.json()).items
                      resolve(records.map(record => this._keysFilter(record, args.keys)))
                  }
                  catch (_) { /**💡 All api responses are expected to return json */ }
              reject({ url: response.url, status: response.status })
          }))
      }

      try {
          let records = await Promise.all(reqs)
          records = records.flat()
          if (total > page_length) records.length = page_length
          return records

      } catch (e) { throw e }
  }

  /**
   * @argument {String} filter
   * @argument {String} sort
   * @argument {String} keys
   * @argument {String} expand
   */
  async getFullList(args = {}) {
      const record_count = await this.getCount(args.filter)
      return await this.getList(args, record_count)
  }

  /**
   * @param {String} filter
   */
  async getCount(filter) {
      const response = await fetch(`${this.api_url}?page=1&perPage=1${this._serializeQueryParams({ filter })}`, { headers: this.fetch_headers })
      if (response.ok)
          try {
              return (await response.json()).totalItems
          }
          catch (_) { /**💡 All api responses are expected to return json */ }
      throw { url: response.url, status: response.status }
  }


  _serializeQueryParams(e) {
      // ⛩️ Patched from https://github.com/pocketbase/js-sdk/blob/0aa9a3b1648ce2672399385caee060ee7488edd1/src/Client.ts#L335
      let i = []; for (let t in e) { if (!e[t]) continue; let n = e[t], r = encodeURIComponent(t); if (Array.isArray(n)) for (let o of n) i.push(r + "=" + encodeURIComponent(o)); else n instanceof Date ? i.push(r + "=" + encodeURIComponent(n.toISOString())) : "object" == typeof n ? i.push(r + "=" + encodeURIComponent(JSON.stringify(n))) : i.push(r + "=" + encodeURIComponent(n)) } return (i.length ? '&' : '').concat(i.join("&"))
  }
  _keysFilter(record, keys) {
      record.id = !isNaN(record.id) ? +record.id : record.id
      if (keys?.length) {
          keys = Array.isArray(keys) ? keys : keys.split(' ')
          record = Object.fromEntries(Object.entries(record)
              .filter(([key]) => keys.includes(key) || key === 'expand' && keys.some(k => k.startsWith('expand')))
              .map(([key, value]) => {
                  if (key === 'expand' && keys.some(k => k.startsWith('expand'))) {
                      let expand_obj = value
                      expand_obj = Object.fromEntries(Object.entries(expand_obj).map(([key_, value_]) => {
                          return [
                              key_,
                              this._keysFilter(value_, keys.filter(k => k.startsWith(`expand.${key_}.`)).map(k => k.replace(`expand.${key_}.`, '')))
                          ]
                      }))
                      return [key, expand_obj]
                  }
                  return [key, value]
              })
          )
          if (record.expand) {
              const expand = record.expand
              delete record['expand']
              record = { ...record, ...expand }
          }
      }
      else {
          delete record['created']
          delete record['updated']
          delete record['collectionId']
          delete record['collectionName']
      }

      return record
  }
  _sortByKey(array, key) {
      const reversed = key.startsWith('-')
      if (reversed) key = key.slice(1)

      return array.sort((a, b) => {
          const x = reversed ? b[key] : a[key]
          const y = reversed ? a[key] : b[key]
          return ((x < y) ? -1 : ((x > y) ? 1 : 0))
      });
  }
  _biggestDivisor(n) {
      const dv = Math.ceil(n / 400)
      if (!Number.isInteger(n / dv)) return [400 * dv, dv]
      return [n / dv, dv]
  }
}