// Calls the UAE Corporate Registry Monitor actor and prints each new/changed entity.
// Install: npm install apify-client
// Run:     APIFY_TOKEN=your_token node examples/call-actor.cjs

const { ApifyClient } = require('apify-client');

const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

async function main() {
    const input = {
        dataSources: ['ADGM_FREEZONE', 'DIFC_FREEZONE'],
        maxItems: 100,
        onlyNew: true,
    };

    const run = await client.actor('BmhA43NYN15DxOLTD').call(input);

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    for (const item of items) {
        console.log(`${item.event_type}: ${item.commercial_name_en} (${item.data_source}) - ${item.registration_status}`);
    }

    console.log(`Fetched ${items.length} records. Full run: https://console.apify.com/actors/runs/${run.id}`);
}

main();
