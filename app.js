import 'dotenv/config'
import got from 'got'
import PocketBaseInterface from './pocketbase-interface.js'

const $db_mass = new PocketBaseInterface('merge_mass_tokens')
const $db_merge_history = new PocketBaseInterface('merge_history')
const $db_matter = new PocketBaseInterface('merge_matter_tokens')
await $db_mass.auth(process.env.POCKETBASE_USER, process.env.POCKETBASE_PASSWORD)
await $db_merge_history.auth(process.env.POCKETBASE_USER, process.env.POCKETBASE_PASSWORD)
await $db_matter.auth(process.env.POCKETBASE_USER, process.env.POCKETBASE_PASSWORD)

const MASS_CONTRACT_ADDRESS = "0xc3f8a0f5841abff777d3eefa5047e8d413a1c9ab"
const MASS_TOKENS = 28990
const MATTER_CONTRACT_ADDRESS = "0x9ad00312bb2a67fffba0caab452e1a0559a41a9e"
const MATTER_TOKENS = 1395

const tanabata = got.extend({ prefixUrl: "https://tanabata.tina.cafe/", headers: { 'X-API-KEY': process.env.TANABATA_API_KEY }, retry: { limit: 10 }, responseType: 'json', resolveBodyOnly: true })
const alchemy_api = got.extend({ prefixUrl: "https://eth-mainnet.alchemyapi.io/jsonrpc/ER1Uh6Lu38x2xWXc7IomSmYFO5twNigV", responseType: 'json', resolveBodyOnly: true, retry: { methods: ['POST'] } })
const nifty_metadata_api = got.extend({ prefixUrl: "https://api.niftygateway.com/nifty/metadata-minted/", responseType: 'json', resolveBodyOnly: true })
const os_api = got.extend({ prefixUrl: "https://api.opensea.io/api/v1/", responseType: 'json', resolveBodyOnly: true })
const ipfs_api = got.extend({ prefixUrl: "https://cloudflare-ipfs.com/ipfs/", responseType: 'json', resolveBodyOnly: true, retry: { limit: 10 } })
const coinbase_api = got.extend({ prefixUrl: "https://api.coinbase.com/v2/", responseType: 'json', resolveBodyOnly: true })
const eth_usd = +(await coinbase_api('exchange-rates?currency=ETH')).data.rates.USD
const known_merged = (await $db_mass.getFullList({ filter: "merged = true", keys: "id" })).map(r => +r.id)
const all_mass_tokens = (await $db_mass.getFullList({ keys: "id mass alpha tier class merges merged merged_to merged_on sale_price" }))

console.time(`overall`)
const REQUESTS = []
const batch_size = 100

for (let id = 1; id <= MATTER_TOKENS; id++) REQUESTS.push({ id, f: scanMatterToken })
for (let id = 1; id <= MASS_TOKENS; id++) REQUESTS.push({ id, f: scanMassToken })
while (REQUESTS.length) {
    console.log('stack length: ', REQUESTS.length)
    console.time(`token batch`)
    await Promise.all(REQUESTS.splice(0, batch_size).map((o) => o.f(o.id)))
    console.timeEnd(`token batch`)
}

// 📝 Save some stats for history
let os_resp = await os_api.get("collection/m/stats")
const token_count = await $db_mass.getCount("merged = false")
const merged_count = await $db_mass.getCount("merged = true")
let tiers_count = [], classes_count = []
for (let it = 1; it <= 4; it++) tiers_count.push($db_mass.getCount(`tier = ${it} && merged = false`))
tiers_count = await Promise.all(tiers_count)
for (let ic = 0; ic < 100; ic++) classes_count.push($db_mass.getCount(`class = ${ic} && merged = false`))
classes_count = await Promise.all(classes_count)

await $db_merge_history.create({
    os_price_floor: os_resp.stats.floor_price,
    token_count,
    merged_count,
    tiers_count,
    classes_count,
    total_mass: 312729,
    timestamp: (new Date).toISOString()
})
await tanabata.post('merge/clear_cache')

console.timeEnd(`overall`)



// 🔭 Scan functions
async function scanMassToken(id) {
    if (known_merged.includes(id)) return

    let attributes, merged = false, merged_to, merged_on, sale_price

    attributes = await askWeb3ApiNode(MASS_CONTRACT_ADDRESS, id)
    if (!attributes) {
        // 💫 This is a merged token
        merged = true
        const db_token = await $db_mass.getOne(id)
        attributes = [
            { trait_type: 'Mass', value: db_token.mass },
            { trait_type: 'Alpha', value: db_token.alpha },
            { trait_type: 'Tier', value: db_token.tier },
            { trait_type: 'Class', value: db_token.class },
            { trait_type: 'Merges', value: db_token.merges }
        ];
        ([merged_to, merged_on] = await askAlchemy(id))

        sale_price = await askOpenSeaPrice(id)
        // if (!sale_price) sale_price = await askNiftyMarket(id)
    }
    
    const data = {
        id: id.toString().padStart(15, 0),
        mass: +attributes.filter(a => a.trait_type === 'Mass')[0].value,
        alpha: attributes.filter(a => a.trait_type === 'Alpha')[0].value == 1,
        tier: +attributes.filter(a => a.trait_type === 'Tier')[0].value,
        class: +attributes.filter(a => a.trait_type === 'Class')[0].value,
        merges: +attributes.filter(a => a.trait_type === 'Merges')[0].value,
        merged,
        merged_to: merged_to?.toString().padStart(15, 0),
        merged_on,
        sale_price,
    }
    if (!all_mass_tokens.some(token => deepEqual({
        ...token,
        id: token.id.toString().padStart(15, 0),
        merged_on: token.merged_on.length === 0 ? undefined : token.merged_on,
        merged_to: token.merged_to.length === 0 ? undefined : token.merged_to,
        sale_price: token.sale_price === 0 ? undefined : token.sale_price
    }, data))) {
        await $db_mass.update(data.id, data)
    }
}

async function scanMatterToken(id) {
    let attributes = await askWeb3ApiNode(MATTER_CONTRACT_ADDRESS, id)
    // if (!attributes) attributes = await askOpenSeaMetadata(MATTER_CONTRACT_ADDRESS, id);
    if (!attributes) return // 🥅 Ignore burnt Matter

    // 💡 0 is for the 3 Lucky Giants which don't really have parents
    if (attributes.filter(a => a.trait_type === 'Parent')[0].value == 0)
        attributes.filter(a => a.trait_type === 'Parent')[0].value = undefined

    const data = {
        mass: +attributes.filter(a => a.trait_type === 'Mass')[0].value,
        order: +attributes.filter(a => a.trait_type === 'Order')[0].value,
        parent: attributes.filter(a => a.trait_type === 'Parent')[0].value?.toString().padStart(15, 0),
        type: attributes.filter(a => a.trait_type === 'Type')[0].value
    };

    await $db_matter.update(id, data)
}



// 🛠️ Utils functions
async function askWeb3ApiNode(contract_address, id) {
    const hex = id.toString(16)
    const b32 = '0xc87b56dd' + hex.padStart(64, '0')
    const resp = await got('https://node1.web3api.com/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', referer: 'etherscan.io' },
        body: `{"jsonrpc":"2.0","id":${id},"method":"eth_call","params":[{"from":"0x0000000000000000000000000000000000000000","data":"${b32}","to":"${contract_address}"},"latest"]}`,
        responseType: 'json', resolveBodyOnly: true,
        retry: { methods: ['POST'], statusCodes: [520], errorCodes: ['ENOBUFS', 'ECONNRESET'] }
    })

    if (resp.error) return undefined

    const uri = byte32ToString(resp.result)
    if (uri.includes('json;base64,')) {
        const metadata_b64 = uri.split('json;base64,')[1]
        const metadata = JSON.parse(Buffer.from(metadata_b64, 'base64').toString())
        return metadata.attributes
    }
    else if (uri.includes('ipfs')) {
        const metadata = await ipfs_api(uri.split('ipfs://')[1])
        return metadata.attributes
    }
    return undefined
}

async function askAlchemy(id) {
    const id_hex = '0x' + id.toString(16).padStart(64, '0')
    const resp = await alchemy_api.post('', { json: { "jsonrpc": "2.0", "id": 20, "method": "eth_getLogs", "params": [{ "fromBlock": "0x0", "toBlock": "latest", "topics": ["0x7ba170514e8ea35827dbbd10c6d3376ca77ff64b62e4b0a395bac9b142dc81dc", [id_hex], null], "address": MASS_CONTRACT_ADDRESS }] } })

    if (resp?.result.length == 0) {
        console.log("alchemy error on", id);
        return [undefined, undefined]
    }

    const merged_to = parseInt(resp.result[0].topics[2], 16) ? parseInt(resp.result[0].topics[2], 16) : undefined // 🥅 Change 0 to undefined (for $db relation reason)
    const merged_on = (await tanabata.get(`eth/chain/block?block_id=${Number(resp.result[0].blockNumber, 16)}`)).timestamp * 1000


    return [merged_to, new Date(merged_on).toUTCString()]
}

async function askNiftyMetadata(contract_address, id) {
    const { niftyMetadata } = await nifty_metadata_api.get(`?contractAddress=${contract_address}&tokenId=${id}`)

    return [
        { trait_type: 'Mass', value: +niftyMetadata.description },
        { trait_type: 'Alpha', value: niftyMetadata.trait_values.filter(a => a.trait.name === 'Alpha')[0].value == 1 },
        { trait_type: 'Tier', value: +niftyMetadata.trait_values.filter(a => a.trait.name === 'Tier')[0].value },
        { trait_type: 'Class', value: +niftyMetadata.trait_values.filter(a => a.trait.name === 'Class')[0].value },
        { trait_type: 'Merges', value: +niftyMetadata.trait_values.filter(a => a.trait.name === 'Merges')[0].value }
    ]
}

async function askOpenSeaPrice(id) {
    let sale_price;
    try {
        const { last_sale } = await os_api(`asset/${MASS_CONTRACT_ADDRESS}/${id}/?format=json`)

        if (last_sale) {
            if (last_sale.payment_token?.symbol === 'ASH')
                sale_price = (last_sale.payment_token.eth_price * 10) * last_sale.total_price / 10e17;
            else sale_price = last_sale.total_price / 10e17;
        }
    } catch (_) { }

    return sale_price
}

function byte32ToString(hex) {
    let str = '';
    let i = 0;
    if (hex.substring(0, 2) === '0x') {
        i = 2;
    }
    for (; i < hex.length; i += 2) {
        const code = parseInt(hex.substr(i, 2), 16);
        str += String.fromCharCode(code);
    }
    return str;
};

function deepEqual(object1, object2) {
    const keys1 = Object.keys(object1)
    const keys2 = Object.keys(object2)
    if (keys1.length !== keys2.length) return false
    for (const key of keys1) {
        const val1 = object1[key]
        const val2 = object2[key]
        const areObjects = isObject(val1) && isObject(val2)
        if (areObjects && !deepEqual(val1, val2) || !areObjects && val1 !== val2)
            return false
    }
    return true
}
function isObject(object) {
    return object != null && typeof object === 'object'
}