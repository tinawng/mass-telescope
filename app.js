import dotenv from 'dotenv'
import got from 'got';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
dotenv.config();
puppeteer.use(StealthPlugin());
const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 937 });

const merge_contract = "0xc3f8a0f5841abff777d3eefa5047e8d413a1c9ab";
const nifty_omnibus = "0xe052113bd7d7700d623414a0a4585bcae754e9d5";
const ethscan_url = `https://etherscan.io/token/${merge_contract}?a=`;
const nifty_url = `https://niftygateway.com/marketplace?collectible=${merge_contract}&filters[onSale]=true&tokenId=`;
const os_api = got.extend({ prefixUrl: "https://api.opensea.io/api/v1/", headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/97.0.4692.99 Safari/537.36' }, responseType: 'json', resolveBodyOnly: true });
const web3_api = got.extend({ prefixUrl: "https://node1.web3api.com/", responseType: 'json', resolveBodyOnly: true });
const cryptocompare_api = got.extend({ prefixUrl: "https://min-api.cryptocompare.com/data", responseType: 'json', resolveBodyOnly: true });
const tanabata_api = got.extend({ prefixUrl: "https://tanabata.tina.cafe/pak/", headers: { secret: process.env.TANABATA_SECRET }, responseType: 'json', resolveBodyOnly: true });

//♻️ Already known merged token
const known_merged = await tanabata_api('merged_tokens');
//💲 Get eth/usd price
const eth_usd = (await cryptocompare_api('price?fsym=ETH&tsyms=USD').json()).USD;

// ⚫️ Parsing all tokens: 130 * 223 = 28,990
for (let chunk = 0; chunk < 130; chunk++) {
    // ⚡️ Making url list for // request exec
    let urls = [];
    for (let i = 1; i <= 223; i++) {
        let hex = (223 * chunk + i).toString(16);
        let b32 = '0xc87b56dd' + hex.padStart(64, '0');
        urls.push(web3_api.post('', { json: { "jsonrpc": "2.0", "id": (223 * chunk + i), "method": "eth_call", "params": [{ "from": "0x0000000000000000000000000000000000000000", "data": b32, "to": merge_contract }, "latest"] }, headers: { referer: 'etherscan.io' } }).json());
    }

    // 🗃️ Store api responses
    // console.time(`tokens   ${chunk}`);
    let tokens = await Promise.all(urls);
    // console.timeEnd(`tokens   ${chunk}`);

    // console.time(`metadata ${chunk}`);
    // 🔍️ Parse api responses and create token object (+ some extra infos)
    for (let i = 0; i < tokens.length; i++) {
        const api_resp = tokens[i];

        let merged_to, merged_on, sale_price;
        if (!api_resp.error) {
            var b64json = byte32ToString(api_resp.result).split('json;base64,')[1];
        }
        else {
            // 💫 This is a merged token

            // 🔎 Is this a known merged?
            if (known_merged.find(t => t.id === api_resp.id && t.merged_to)) {
                //⚡ Merged token metadata wont change, re-using previous record
                let token = known_merged.find(t => t.id === api_resp.id)

                // 🤖 Simulating json
                let json = {
                    attributes: [
                        { trait_type: 'Mass', value: token.mass },
                        { trait_type: 'Alpha', value: token.alpha },
                        { trait_type: 'Tier', value: token.tier },
                        { trait_type: 'Class', value: token.class },
                        { trait_type: 'Merges', value: token.merges }
                    ]
                }

                var b64json = Buffer.from(JSON.stringify(json)).toString("base64");
                merged_to = token.merged_to;
                merged_on = token.merged_on;
                sale_price = token.sale_price;
            }
            else {
                try {
                    // 💰 Get transaction price & metadatas
                    let { token_metadata, last_sale } = await os_api(`asset/${merge_contract}/${api_resp.id.toString()}/?format=json`).json();
                    var b64json = token_metadata.split('json;base64,')[1];

                    if (last_sale) {
                        if (last_sale.payment_token.symbol === 'ASH')
                            sale_price = (last_sale.payment_token.eth_price * 10) * last_sale.total_price / 10e17;
                        else sale_price = last_sale.total_price / 10e17;

                        // ⚫️ Get merge date & buyer merge token id
                        merged_on = await scrapEtherScan(api_resp.id);
                        [merged_to] = await scrapNiftyScan(api_resp.id);
                    }
                    else {
                        // ⚫️ Get merge date, buyer merge token id & sale price
                        merged_on = await scrapEtherScan(api_resp.id);
                        [merged_on, sale_price] = await scrapNiftyScan(api_resp.id);
                    }

                } catch (e) {
                    // 🌱 Token has been merged before the re-mint
                    // console.error(e);
                }
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
    }
    // console.timeEnd(`metadata ${chunk}`);

    tanabata_api.post('merges', { json: tokens });
}

await browser.close();

// 📸 Save history snapshot
await tanabata_api('snap_history');


async function scrapEtherScan(token_id) {
    await page.goto(ethscan_url + token_id);
    await page.waitForSelector('iframe');
    const frames = await page.frames();

    const transfers_frame = frames.find(f => f.name() == "tokentxnsiframe");
    await transfers_frame.waitForSelector('.hash-tag');
    const frame_content = await transfers_frame.content();

    return new Date(frame_content.split(`ago">`)[1].split('<')[0].concat(' UTC'));;
}

async function scrapNiftyScan(token_id) {
    await page.goto(nifty_url + token_id);
    await page.waitForSelector('.MuiTypography-h3');
    await page.waitForFunction(() => !document.querySelector('.MuiTypography-h3').innerHTML.includes('--'));
    let content = await page.content();
    let merged_to = content.split('This mass has been merged into #')[1].split('</h3>')[0]
    let sale_price = Number(content.split('MuiTableCell-body\"><span>$')[1].split('</span>')[0].trim().replaceAll(',', '')) / eth_usd;

    return [Number(merged_to), sale_price];
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
