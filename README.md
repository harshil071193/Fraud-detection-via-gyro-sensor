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
- **Retakes:** only the last photo of each label is used. Interior photos are shown in their own section (see below); other photos that aren't exterior positions (for example odometer or VIN) are ignored.
- **Missing data:** signals that can't be calculated (no GPS, no orientation, fewer than 3 photos) are left out of the score instead of counting as 0. If less than half the signal weight is available, the verdict is "Insufficient data".
- **Warnings box:** under the verdict cards, the page lists all of the above, plus when the two logs come from different platforms, devices or app versions.

## Logs from fixed revamp builds

Revamp builds with the sensor accuracy fix write extra fields. Older logs (boltSA, or earlier revamp builds) don't have them and still work.

- `metadata.motionSensorSource` (`native` or `react_native_sensors`) and `metadata.headingReference`: shown on each verdict card. A log without `motionSensorSource` gets a note that it is from an older build, which has the acceleration unit bug and the gaps.
- `cameraHeading` on Orientation rows: compared with the heading this page calculates from the quaternion (**Logged cameraHeading matches the quaternion** check). The per-photo table shows the app's value under the page's value.
- `metadata.walkaroundStatus`, `walkaroundPhotoCount`, `walkaroundReversals`, `walkaroundSweepDeg`: the app's own walk-around flag. It is shown on the verdict card, and the page re-runs the same rule to check it (**App walk-around flag matches this page**). The rule is simpler than the fraud score: 2+ heading reversals, or under 180° sweep with 6+ photos, is suspicious.
- Exterior photo annotations: `label` is the angle name shown on the capture screen (for example `Front Passenger Corner`) and `position` is the slot key (for example `front-left`). The page places photos by `position` when it is present, and otherwise reads the slot from the label (`front-left-capture.jpg` in older logs).
- Interior photo annotations: `label` is the name shown on the interior capture screen (for example `Passenger Front Seat` or `Boot/Trunk`) and `position` is the interior upload key (for example `passenger-front-side` or `boot-space`). Older logs label them `<position>-capture.jpg`; both are recognised. The **Interior photos** section lists which of the seven were taken, when, and how far each GPS fix is from the centre of the exterior photos. A photo more than 20 m away (or twice its GPS accuracy, if larger) gets a warning. Interior photos never join the walk-around and don't change the fraud score.
- Timeline: the page builds it from each row's `time` (native sensor timestamp) minus `metadata["recording epoch time"]`, and only falls back to `seconds_elapsed` when `time` is missing. Some revamp builds restarted `seconds_elapsed` from 0 when the app came back to the foreground or a journey was resumed; the **seconds_elapsed never restarts** check and a warning show this. Some builds also interleaved rows from two overlapping sensor flushes; those show as out-of-order rows in **Timestamps in order** and a warning. Both are fixed in revamp. Location rows are left out of these checks and of the photo snapshot timing, because their `time` comes from the GPS clock.

The recommendations list only shows problems found in the loaded logs, so a pair of logs from a fixed build shows fewer items.

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
