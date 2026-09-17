# Calls the UAE Corporate Registry Monitor actor and prints each new/changed entity.
# Install: pip install apify-client
# Run:     APIFY_TOKEN=your_token python examples/call_actor.py

import os

from apify_client import ApifyClient

client = ApifyClient(os.environ["APIFY_TOKEN"])

run_input = {
    "dataSources": ["ADGM_FREEZONE", "DIFC_FREEZONE"],
    "maxItems": 100,
    "onlyNew": True,
}

run = client.actor("BmhA43NYN15DxOLTD").call(run_input=run_input)

items = list(client.dataset(run["defaultDatasetId"]).iterate_items())
for item in items:
    print(f"{item['event_type']}: {item['commercial_name_en']} ({item['data_source']}) - {item['registration_status']}")

print(f"Fetched {len(items)} records. Full run: https://console.apify.com/actors/runs/{run['id']}")
