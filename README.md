# Fraud-detection-via-gyro-sensor

Side-by-side comparison of two smart recording sensor logs: inspection timing, missing data, whether the photographer really walked around the car, how accurate our sensor implementation is, and a fraud risk score.

The page itself is called **Sensor Log Tracker**. It covers inspection timing, data gaps, a walk-around-the-car diagram, implementation accuracy checks and a fraud risk score.

## Open

Double-click `index.html`. It works offline; Chart.js, the analysis code and both logs are inside the file.

The included logs are:

- **A, Normal inspection:** `sensor_log_2ec2a361-…_2026-10-01_11-02-44.json`
- **B, Intentional fraud** (a walk around a different car or object): `sensor_log_4dc5ebeb-…_2026-10-01_10-29-36.json`

## Compare other logs

- Drag two JSON files anywhere on the page. The first becomes A and the second becomes B.
- Drag one file onto slot A or slot B, or use **Choose**.
- **Swap A / B** switches the two. **Reset to included logs** goes back to the included pair.
- You can rename each log in its slot.

Everything runs in the browser and nothing is uploaded.

## Rebuild

After editing anything in `src/`:

```bash
node build.mjs
```

To include a different pair of logs by default:

```bash
node build.mjs path/to/logA.json path/to/logB.json "Name A" "Name B"
```

## Files

- `src/engine.js`: the analysis (parsing, rates, gaps, GPS ring, camera heading from the quaternion, accuracy checks, fraud signals and weights). Tune thresholds here.
- `src/app.js`: rendering, charts, diagrams and drag-and-drop.
- `src/template.html` and `src/styles.css`: page layout and styling.
- `vendor/chart.umd.min.js`: Chart.js 4.4.4.
- `logs/`: copies of the two included logs.

## Logs from any device or app

- **Android or iOS:** read from `metadata.platform`. If it's missing, the page detects it from the device name, or from the Android acceleration unit bug. iOS orientation uses north/west/up axes, so it is converted before the heading is calculated.
- **Photo labels:** different naming styles are matched to positions around the car, for example `front-left-capture.jpg`, `FRONT_LEFT_IMAGE` or `left_front`. Labels like `img_1` can't be matched. Those photos are used in time order, and the checks that need positions are skipped.
- **Retakes:** only the last photo of each label is used. Photos that aren't exterior positions (for example interior) are ignored.
- **Missing data:** signals that can't be calculated (no GPS, no orientation, fewer than 3 photos) are left out of the score instead of counting as 0. If less than half the signal weight is available, the verdict is "Insufficient data".
- **Warnings box:** under the verdict cards, the page lists all of the above, plus when the two logs come from different platforms, devices or app versions.

## How the fraud score works

The camera heading at each photo is calculated from the orientation quaternion (`qx`, `qy`, `qz`, `qw`). The logged compass is not used, because it is not tilt-compensated. A genuine walk-around keeps turning one way through about 315°, and the camera points at the centre of the walked ring.

The score adds up weighted signals:

- Heading reversals
- Total sweep
- Error against each photo's expected position around the car
- Camera pointing away from the centre
- GPS walk order
- Ring size
- Gyroscope activity
- Uneven timing
- Gaps near photos

The weights were tuned on only these two recordings, so treat the score as a guide.
