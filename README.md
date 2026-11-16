# WahouWah — web controller

Web Bluetooth port of the Keyztone WahouWah app (Android replacement). Static site, no build step.

## Use
- Open the page over HTTPS in **Chrome on Android** (Chrome/Edge on desktop also work). Not supported by iOS browsers.
- Press **CONNECT TO WAHOUWAH**, pick the pedal, accept the Android pairing request.
- "Add to Home screen" installs it as an app (works offline once loaded).
- `?demo` (or "Demo mode") runs the UI without a pedal.

## Pairing
The firmware bonds (Just Works), advertises with a whitelist and rejects re-pairing from an already bonded phone.
If connection fails: forget "WahouWah" in Android Bluetooth settings, clear the bond on the pedal, then connect again.

## Not included
Firmware update (DFU) — use the iOS app.

## Protocol (from Firmware/ble_wah.h and the Xamarin app)
Service `214d1400-df5f-73a4-2345-4c190000e9a9`; characteristics `214dXXXX-…`, little-endian, encrypted link required.

| Char | Content |
|---|---|
| 1401 | active preset, u8 0–5 (read/write/notify) |
| 1406 | pedal position, u16 0–1023 (notify) |
| 1407 | calibration, 14 bytes: SOURCE, EXP_STATUS, WAH_STATUS, DATA u16, WAH_GAIN, EXP_HEEL, EXP_TOE, WAH_HEEL, WAH_TOE (u16) |
| 1408 | stroke, 12 bytes: STATUS, SOURCE, EXP_CURVE, WAH_CURVE, EXP_HEEL, EXP_TOE, WAH_HEEL, WAH_TOE (u16) |
| 1410–1415 | presets 1–6, 45 bytes: FC1, FC2, Q1, Q2, LV1, LV2, STATUS (0 edit / 1 save to flash), MODE, AUTO, TIME_AUTO_WAH u32, TIME_AUTO_LEVEL u32, COLOR, MIX_DRY1, MIX_DRY2, FILTER_TYPE, SOURCE (2 exp / 3 wah), BYPASS_SOURCE, GAIN, CURVE_RESPONSE, NAME[20] |
| 1416 | "first connection" flag, u8 (0 = already calibrated) |
| 1417 | MAC address (read) |

## Files
`index.html`, `style.css`, `app.js` (all logic), `factoryPresets.json` (46 factory presets), `sw.js` + `manifest.webmanifest` (install/offline), `assets/` (graphics and font from the app).
