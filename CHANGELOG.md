# Changelog

## 1.0.0 (2026-10-06)


### Features

* **api:** sign civilians up by phone instead of email ([1db9d23](https://github.com/RayHCai/ember/commit/1db9d23efaf22ddbf34a47ed31fd4a897d2d7e4f))
* **api:** store edge records and serve zones, scans, placements and risk ([eeb4e4f](https://github.com/RayHCai/ember/commit/eeb4e4f501b9596133665bddfcc0021bb2258357))
* **api:** update api service ([7490064](https://github.com/RayHCai/ember/commit/74900642ca40ed740eed592442398244ec2fa80d))
* **asset-builder:** update asset-builder tool ([5b9ed46](https://github.com/RayHCai/ember/commit/5b9ed46ac509a83add8e148717d8160b63533bc7))
* **assets:** regenerate sim assets ([c354e52](https://github.com/RayHCai/ember/commit/c354e5266d0000db87fb465717f369303dc23959))
* **civilian-map:** update civilian-map app ([9f1d3c5](https://github.com/RayHCai/ember/commit/9f1d3c5a28f610b511d56ecde5293e692eb9947d))
* **contact-collector:** add the public signup page ([96643fc](https://github.com/RayHCai/ember/commit/96643fcf9352b452c41a77f2772b362edbd43fb3))
* **contact-collector:** add the public signup page ([3ca20a7](https://github.com/RayHCai/ember/commit/3ca20a77dfef5719c9550e0b7b619b3b6d6f6478))
* **contact-collector:** update contact-collector app ([18ed45e](https://github.com/RayHCai/ember/commit/18ed45ec1be78f5673f4e6e46e7c2d981411cdd0))
* **contracts:** extend shared wire types ([9df3211](https://github.com/RayHCai/ember/commit/9df3211de44b440fca7eb0a43724767fa102bb0e))
* **dashboard:** replace the setup wizard with a draw page and drop the sidebar ([442d1a0](https://github.com/RayHCai/ember/commit/442d1a0ff4a50a681c3417160a5c925583a8251e))
* **dashboard:** run on the api and restyle in the editorial look ([d06521c](https://github.com/RayHCai/ember/commit/d06521cd29671ff280d638fa862590bd5a2d000e))
* **dashboard:** share the Ember brand mark from assets/brand ([c5da23e](https://github.com/RayHCai/ember/commit/c5da23e42f96e580c0c0403bc2d8d8e55a56d490))
* **dashboard:** update dashboard app ([82f503f](https://github.com/RayHCai/ember/commit/82f503fbeea69e4a4c0cd2265b3df3588c348b64))
* **demo-data:** add a control page for the scenario clock ([4c3676f](https://github.com/RayHCai/ember/commit/4c3676fa78d93dd46320bef11f16d873ff845f93))
* **demo-data:** update demo-data service ([a95a536](https://github.com/RayHCai/ember/commit/a95a5365ebf95a4d0516fb49a8d7ce5c35af3540))
* **drone-info:** update drone-info service ([e719f47](https://github.com/RayHCai/ember/commit/e719f4752b2646a253bad92413512bf447a9362d))
* **drone-runtime:** discover the edge-connector over mDNS and fly a simulated fleet ([5208f3a](https://github.com/RayHCai/ember/commit/5208f3a20923a718e0fd800c786fc0a1fd640467))
* **drone-runtime:** load fire-seg-v1 by default and send telemetry at 10 Hz ([10fe343](https://github.com/RayHCai/ember/commit/10fe343c549dcef1af6d161f6f388763946a9f1c))
* **drone-runtime:** update drone-runtime service ([dab1141](https://github.com/RayHCai/ember/commit/dab114144a1a08e74336018d439687b4c89ab6d4))
* **drone-sim:** bundle the brand mark and recolour risk zones ([69d6200](https://github.com/RayHCai/ember/commit/69d6200fbea8cfd50ab4759dfa5f8555f89aaeda))
* **drone-sim:** rename apps/sim to apps/drone-sim ([c4220c4](https://github.com/RayHCai/ember/commit/c4220c4bb08324d5e57a083c87720e035185c0d4))
* **edge-connector:** send edge updates at 20 Hz and smooth drone motion in drone-sim ([ee08087](https://github.com/RayHCai/ember/commit/ee080875ab84252ed1a45061a4cca568a545895d))
* **edge-connector:** update edge-connector service ([55b2d1e](https://github.com/RayHCai/ember/commit/55b2d1ebaa656c141a394c24c3fc6582b959d333))
* **edge-manager:** update edge-manager service ([ee0ba0f](https://github.com/RayHCai/ember/commit/ee0ba0fc074246e2fef9a1105affd04a46d72070))
* **fire-seg:** add fire-seg-v1 model weights ([e5ae7aa](https://github.com/RayHCai/ember/commit/e5ae7aa0203e36bdbc1743717b4abca28f0ec689))
* **fire-seg:** update fire-seg tool ([35daad4](https://github.com/RayHCai/ember/commit/35daad4e4e6a5e0a5bdb1d1ace9dd19d812e08b4))
* **internal:** update shared Go edge packages ([956b0ca](https://github.com/RayHCai/ember/commit/956b0cad4fef3040d06ede70d41fd6131c86d68b))
* **messenger:** update messenger service ([51cc1a5](https://github.com/RayHCai/ember/commit/51cc1a598e22def1525ef5d30169eb244c727215))
* **operator-agent:** draft evacuation alerts and deliver approved blasts over iMessage ([05a4878](https://github.com/RayHCai/ember/commit/05a48788b4e1f20e1b58ff77b509b928ed3b06e1))
* **operator-agent:** reroute once, around every route already texted ([346aa7b](https://github.com/RayHCai/ember/commit/346aa7b6fbac1d37870bf803e64b88aa03d49c06))
* **operator-agent:** send route maps to the notify phone and reroute on request ([23dc113](https://github.com/RayHCai/ember/commit/23dc113acf5efc6c3623b31d10d0987b6408cea0))
* **operator-agent:** update operator-agent service ([af516b5](https://github.com/RayHCai/ember/commit/af516b5b3c196846b8e292f0e5527b43b0bdbc1b))
* **planner:** keep evacuation routes off paths reported blocked ([726efe3](https://github.com/RayHCai/ember/commit/726efe3c43660dcaa47784563b0fbe973077642d))
* **planner:** update planner service ([0307b6b](https://github.com/RayHCai/ember/commit/0307b6b28bf21562588bee6c14c5adc8bf1e5465))
* **responder:** update responder app ([8b62618](https://github.com/RayHCai/ember/commit/8b62618979791f6467c620481461d2efce659314))
* **scripts:** add pnpm demo and the three-machine demo setup ([82eae99](https://github.com/RayHCai/ember/commit/82eae992ac7eae164d4912f08af3f7687c0f8947))
* **scripts:** open the demo dashboard before the drones connect ([4b85774](https://github.com/RayHCai/ember/commit/4b85774bd352d16f1726b9750ed3be0762258919))
* **seed-data:** update seed-data tool ([5d53c65](https://github.com/RayHCai/ember/commit/5d53c654fb860920b2aa9b6e3d9d5a41fe352548))
* **voice-agent:** update voice-agent service ([04e651f](https://github.com/RayHCai/ember/commit/04e651f0304ebd1e4c7c0f5f007c8d5c20c80a11))


### Bug Fixes

* **docker:** drop pnpm cache mounts for Railway builds ([c227b16](https://github.com/RayHCai/ember/commit/c227b167093084c115dc305fe0cf81742062e6a2))
