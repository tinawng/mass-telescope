import dotenv from 'dotenv'
import got from 'got';
dotenv.config();

// const os_api = got.extend({ prefixUrl: "https://api.opensea.io/api/v1/asset/0xc3f8a0f5841abff777d3eefa5047e8d413a1c9ab/", responseType: 'json', resolveBodyOnly: true });
// os_api.get(`${token_id.toString()}?format=json`).json();
const web3_api = got.extend({ prefixUrl: "https://node1.web3api.com/", responseType: 'json', resolveBodyOnly: true });
const tanabata_api = got.extend({ prefixUrl: "https://tanabata.tina.cafe/pak/merges", headers: { secret: process.env.TANABATA_SECRET }, responseType: 'json', resolveBodyOnly: true });

try {
    // Parsing all tokens: 130 * 223 = 28,990
    for (let chunk = 0; chunk < 130; chunk++) {
        // Making url list for // request exec
        let urls = []
        for (let i = 1; i <= 223; i++) {
            let hex = (223 * chunk + i).toString(16);
            let b32 = '0xc87b56dd' + hex.padStart(64, '0');
            urls.push(web3_api.post('', { json: { "jsonrpc": "2.0", "id": (223 * chunk + i), "method": "eth_call", "params": [{ "from": "0x0000000000000000000000000000000000000000", "data": b32, "to": "0xc3f8a0f5841abff777d3eefa5047e8d413a1c9ab" }, "latest"] }, headers: { referer: 'etherscan.io' } }).json());
        }

        // Store api responses
        console.time(chunk);
        let tokens = await Promise.all(urls);
        console.timeEnd(chunk);

        tokens = tokens.map(api_resp => {
            if (!api_resp.error) {
                var b64json = byte32ToString(api_resp.result).split('json;base64,')[1];
                var metadata = JSON.parse(Buffer.from(b64json, 'base64').toString());
            }

            return {
                id: api_resp.id,
                mass: metadata?.attributes.filter(a => a.trait_type === 'Mass')[0].value,
                alpha: metadata?.attributes.filter(a => a.trait_type === 'Alpha')[0].value,
                tier: metadata?.attributes.filter(a => a.trait_type === 'Tier')[0].value,
                class: metadata?.attributes.filter(a => a.trait_type === 'Class')[0].value,
                merges: metadata?.attributes.filter(a => a.trait_type === 'Merges')[0].value,
                merged: !!api_resp.error,
            }
        })

        tanabata_api.post('', { json: tokens })
    }
} catch (error) {
    console.log(error);
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