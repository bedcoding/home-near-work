# Subway line data

Source: OpenStreetMap contributors, https://www.openstreetmap.org/copyright
Fetched with the Overpass API (https://overpass-api.de). The fetch date is `baseDate` in `subway-lines.json`.

License: Open Database License (ODbL) 1.0, https://opendatacommons.org/licenses/odbl/1-0/
`subway-lines.json` is a derived database and is distributed under the same license.

수도권 전철 노선 묶음(route_master)마다 그 운행 계통(route)이 지나는 선로(way)를 이어 붙이고,
몇 m 안쪽의 굴곡을 지워 좌표 수를 줄였습니다. 노선 이름은 `server/stations-kric.json`의 노선 이름으로 바꿨고,
색은 OSM의 `colour` 값을 그대로 썼습니다. 다시 만들 때는 `node scripts/build-subway-lines.mjs`를 돌립니다.
The data is provided as is without warranty of accuracy or completeness.
