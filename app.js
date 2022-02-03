import dotenv from 'dotenv'
import got from 'got';
dotenv.config();

const contract_address = "0xc3f8a0f5841abff777d3eefa5047e8d413a1c9ab";
const tanabata_api = got.extend({ prefixUrl: "https://tanabata.tina.cafe/pak/", headers: { secret: process.env.TANABATA_SECRET }, responseType: 'json', resolveBodyOnly: true });
const web3_api = got.extend({ prefixUrl: "https://node1.web3api.com/", responseType: 'json', resolveBodyOnly: true });
const alchemy_api = got.extend({ prefixUrl: "https://eth-mainnet.alchemyapi.io/jsonrpc/ER1Uh6Lu38x2xWXc7IomSmYFO5twNigV", responseType: 'json', resolveBodyOnly: true, retry: { limit: 10, methods: ['POST'] } });
const os_api = got.extend({ prefixUrl: "https://api.opensea.io/api/v1/", responseType: 'json', resolveBodyOnly: true, retry: { limit: 10, calculateDelay: ({ attemptCount }) => attemptCount * 2000 } });
const nifty_market_api = got.extend({ prefixUrl: "https://api.niftygateway.com/market/nifty-secondary-market/", responseType: 'json', resolveBodyOnly: true, retry: { limit: 10, methods: ['POST'], calculateDelay: ({ attemptCount }) => attemptCount * 2000 } });
const nifty_metadata_api = got.extend({ prefixUrl: "https://api.niftygateway.com/nifty/metadata-minted/", responseType: 'json', resolveBodyOnly: true, retry: { limit: 10, calculateDelay: ({ attemptCount }) => attemptCount * 2000 } });
const cryptocompare_api = got.extend({ prefixUrl: "https://min-api.cryptocompare.com/data", responseType: 'json', resolveBodyOnly: true });
const eth_usd = (await cryptocompare_api('price?fsym=ETH&tsyms=USD').json()).USD;

Array.prototype.random = function () { return this[Math.floor((Math.random() * this.length))]; }

//♻️ Already known merged token
// const known_merged = await tanabata_api('merged_tokens');

console.time(`overall`);
// ⚫️ Parsing all tokens: 130 * 223 = 28,990
for (let chunk = 0; chunk < 130; chunk++) {
    // ⚡️ Making url list for // request exec
    let urls = [];
    for (let i = 1; i <= 223; i++) {
        let hex = (223 * chunk + i).toString(16);
        let b32 = '0xc87b56dd' + hex.padStart(64, '0');
        urls.push(
            new Promise(async (resolve, reject) => {
                let api_resp = await web3_api.post('', { json: { "jsonrpc": "2.0", "id": (223 * chunk + i), "method": "eth_call", "params": [{ "from": "0x0000000000000000000000000000000000000000", "data": b32, "to": contract_address }, "latest"] }, headers: { referer: 'etherscan.io' } }).json();

                let metadata_b64, merged_to, merged_on, sale_price;
                if (api_resp.error) {
                    // 💫 This is a merged token
                    merged_to = await askAlchemy(api_resp.id);

                    if (merged_to) {
                        [metadata_b64, sale_price, merged_on] = await askOpenSea(api_resp.id);
                        if (!sale_price)
                            [merged_on, sale_price] = await askNiftyMarket(api_resp.id);
                    }
                    else {
                        // 🌱  merged_to is undefined, token has been merged before the re-mint
                        metadata_b64 = await askNiftyMetadata(api_resp.id);
                    }
                }
                else
                    metadata_b64 = byte32ToString(api_resp.result).split('json;base64,')[1];

                var metadata = JSON.parse(Buffer.from(metadata_b64, 'base64').toString());

                let token = {
                    id: api_resp.id,
                    mass: metadata?.attributes.filter(a => a.trait_type === 'Mass')[0].value,
                    alpha: metadata?.attributes.filter(a => a.trait_type === 'Alpha')[0].value,
                    tier: metadata?.attributes.filter(a => a.trait_type === 'Tier')[0].value,
                    class: metadata?.attributes.filter(a => a.trait_type === 'Class')[0].value,
                    merges: metadata?.attributes.filter(a => a.trait_type === 'Merges')[0].value,
                    merged: !!api_resp.error,
                    merged_to: merged_to,
                    merged_on: merged_on,
                    sale_price: sale_price,
                }

                resolve(token);
            })
        );
    }

    // 🗃️ Store api responses
    console.time(`tokens   ${chunk}`);
    let tokens = await Promise.all(urls);
    console.timeEnd(`tokens   ${chunk}`);

    // await tanabata_api.post('merges', { json: tokens });
}

// await tanabata_api.post('snap_history');
console.timeEnd(`overall`);

async function askAlchemy(id) {
    let id_hex = '0x' + id.toString(16).padStart(64, '0');
    let resp = await alchemy_api.post('', { json: { "jsonrpc": "2.0", "id": 20, "method": "eth_getLogs", "params": [{ "fromBlock": "0x0", "toBlock": "latest", "topics": ["0x7ba170514e8ea35827dbbd10c6d3376ca77ff64b62e4b0a395bac9b142dc81dc", [id_hex], null], "address": contract_address }] } }).json();

    if (resp?.result.length == 0) return undefined;
    return parseInt(resp.result[0].topics[2], 16);
}

async function askOpenSea(id) {
    let { token_metadata, last_sale } = await os_api(`asset/${contract_address}/${id}/?format=json`, { headers: { 'X-API-KEY': process.env.OPENSEA_API_KEY.split(',').random() } }).json();
    var metadata_b64 = token_metadata.split('json;base64,')[1];
    let merged_on, sale_price;
    if (last_sale) {
        if (last_sale.payment_token.symbol === 'ASH')
            sale_price = (last_sale.payment_token.eth_price * 10) * last_sale.total_price / 10e17;
        else sale_price = last_sale.total_price / 10e17;
        merged_on = last_sale.event_timestamp;
    }
    return [metadata_b64, sale_price, merged_on]
}

async function askNiftyMarket(id) {
    let resp = await nifty_market_api.post('', { json: { "contractAddress": contract_address, "current": 1, "size": 1, "tokenId": id } }).json();

    if (resp?.data?.results[0]?.Type != "sale") return [undefined, undefined];
    return [resp.data.results[0].Timestamp, resp.data.results[0].SaleAmountInCents / 100 / eth_usd]
}
async function askNiftyMetadata(id) {
    let { niftyMetadata } = await nifty_metadata_api.get(`?contractAddress=${contract_address}&tokenId=${id}`).json();

    let trait_values = niftyMetadata.trait_values;
    let metadata_json = {
        attributes: [
            { trait_type: 'Mass', value: Number(niftyMetadata.description) },
            { trait_type: 'Alpha', value: Number(trait_values[4].value) },
            { trait_type: 'Tier', value: Number(trait_values[3].value) },
            { trait_type: 'Class', value: Number(trait_values[2].value) },
            { trait_type: 'Merges', value: Number(trait_values[1].value) }
        ]
    }

    var metadata_b64 = Buffer.from(JSON.stringify(metadata_json)).toString("base64");
    return metadata_b64;
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