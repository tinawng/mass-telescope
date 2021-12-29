import dotenv from 'dotenv'
import got from 'got';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
dotenv.config();
puppeteer.use(StealthPlugin());
const browser = await puppeteer.launch();
const page = await browser.newPage();

const merge_contract = "0xc3f8a0f5841abff777d3eefa5047e8d413a1c9ab";
const ethscan_url = `https://etherscan.io/token/${merge_contract}?a=`;
const os_api = got.extend({ prefixUrl: "https://api.opensea.io/api/v1/", responseType: 'json', resolveBodyOnly: true });
const web3_api = got.extend({ prefixUrl: "https://node1.web3api.com/", responseType: 'json', resolveBodyOnly: true });
const tanabata_api = got.extend({ prefixUrl: "https://tanabata.tina.cafe/pak/", headers: { secret: process.env.TANABATA_SECRET }, responseType: 'json', resolveBodyOnly: true });

// ⚫️ Parsing all tokens: 130 * 223 = 28,990
for (let chunk = 0; chunk < 130; chunk++) {
    // ⚡️ Making url list for // request exec
    let urls = []
    for (let i = 1; i <= 223; i++) {
        let hex = (223 * chunk + i).toString(16);
        let b32 = '0xc87b56dd' + hex.padStart(64, '0');
        urls.push(web3_api.post('', { json: { "jsonrpc": "2.0", "id": (223 * chunk + i), "method": "eth_call", "params": [{ "from": "0x0000000000000000000000000000000000000000", "data": b32, "to": merge_contract }, "latest"] }, headers: { referer: 'etherscan.io' } }).json());
    }

    // 🗃️ Store api responses
    console.time(`tokens   ${chunk}`);
    let tokens = await Promise.all(urls);
    console.timeEnd(`tokens   ${chunk}`);

    console.time(`metadata ${chunk}`);
    // 🔍️ Parse api responses and create token object (+ some extra infos)
    for (let i = 0; i < tokens.length; i++) {
        const api_resp = tokens[i];

        let merged_to, merged_on, sale_price;
        if (!api_resp.error) {
            var b64json = byte32ToString(api_resp.result).split('json;base64,')[1];
        }
        else {
            // 💫 This is a merged token
            try {
                // 📄 Get transaction price & transaction hash
                let { token_metadata, last_sale } = await os_api(`asset/${merge_contract}/${api_resp.id.toString()}`).json();
                var b64json = token_metadata.split('json;base64,')[1];

                if (last_sale) {
                    merged_on = Date.parse(last_sale.event_timestamp);

                    if (last_sale.payment_token.symbol === 'ASH')
                        sale_price = (last_sale.payment_token.eth_price * 10) * last_sale.total_price / 10e17;
                    else sale_price = last_sale.total_price / 10e17;

                    let transaction_hash = last_sale.transaction.transaction_hash;

                    // 📌 Get buyer address
                    let { result } = await web3_api.post('', { json: { "jsonrpc": "2.0", "id": 0, "method": "eth_getTransactionByHash", "params": [transaction_hash] }, headers: { referer: 'etherscan.io' } }).json();
                    let buyer_addrr = result.from;

                    // ⚫️ Get buyer merge token id
                    let { assets } = await os_api(`assets?owner=${buyer_addrr}&asset_contract_address=${merge_contract}`).json();
                    if (assets[0])
                        merged_to = Number(assets[0].token_id);
                    else
                    {
                        // 🤷‍♀️ Buyer no longer has the token, scraping from etherscan
                        [merged_to, merged_on] = await scrapEtherScan(api_resp.id);
                    }
                }
                else {
                    // 👩‍🦯 Not visible using OpenSea api, scraping from etherscan
                    [merged_to, merged_on] = await scrapEtherScan(api_resp.id);
                }
            } catch (e) {
                // 🌱 Token has been merged before the re-mint
                console.error(e);
            }
        }
        var metadata = JSON.parse(Buffer.from(b64json, 'base64').toString());

        tokens[i] = {
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
        console.log(tokens[i]);
    }
    console.timeEnd(`metadata ${chunk}`);

    tanabata_api.post('merges', { json: tokens });
}

await browser.close();

// 📸 Save history snapshot
await tanabata_api('snap_history');


async function scrapEtherScan(token_id) {
    await page.goto(ethscan_url + token_id);
    await page.waitForSelector('iframe');
    const frames = await page.frames();
    const transfers_frame = frames.find(f => f.url().includes(`contractAddress=${merge_contract}`));
    const frame_content = await transfers_frame.content();
    const buyer_addrr = frame_content.split(`${merge_contract}?a=`)[1].slice(0, 42);
    let merged_on = new Date(frame_content.split(`ago">`)[1].split('<')[0].concat(' UTC'));

    // ⚫️ Get buyer merge token id
    let { assets } = await os_api(`assets?owner=${buyer_addrr}&asset_contract_address=${merge_contract}`).json();
    let merged_to = Number(assets[0].token_id);

    return [merged_to, merged_on];
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