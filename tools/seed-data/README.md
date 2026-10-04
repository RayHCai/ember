# @ember/seed-data

Seed data generators for the api. Everything goes in through the api's public routes.

## Lahaina

`lahaina` seeds the August 8, 2023 demo scenario. The geography is approximate, not survey-accurate.

- Watch zone "Lahaina": a 13-point boundary from the coast up the lower West Maui slopes.
- Geography: 14 connected roads (Highway 30, Front St, Lahainaluna Rd, Kuialua St, Ridge Rd, Keawe,
  Shaw, Dickenson and Wainee Sts, Kahoma Bypass, Lahaina Bypass, Wahikuli Rd, Civic Center Rd,
  Puamana Rd), 6 civilian areas, 3 safe zones (Civic Center, Puamana Beach Park, Highway 30 north
  exit), 2 stations. Cross streets share exact junction coordinates with the trunk roads.
- 3 edge servers (`edge-lahaina-1..3`, 1500 m radius), 6 responders at the stations.
- 8 civilians (`civilian1..8@example.com`, ZIP 96761) spread over the areas; civilian 4 lives in
  Lahaina Bypass Homes, the first area a fire on the slopes east of town reaches in the demo.

```
uv run --package ember-seed-data ember-seed-data lahaina --api http://localhost:4001 --key $EMBER_OPERATOR_KEY
uv run --package ember-seed-data ember-seed-data lahaina --out lahaina.json   # fixture only
```

Re-running is safe: the zone is found by name, existing edge servers, responders and civilians are
reused, and geography and civilian details are replaced with the same values.

`--phone +18085550123` gives one seeded civilian a real phone number (civilian 4 by default,
`--phone-civilian N` for another), so alerts and replies for that civilian reach a real phone over
iMessage. The ASI:One supervisor passes `EMBER_DEMO_PHONE` here.
