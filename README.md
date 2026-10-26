# PTZ D-Pad Card

![PTZ D-Pad Card](preview.png)

A round pan/tilt control pad for Home Assistant: up, right, down and left arranged in a circle, with an optional center button.
Works with any **button / input_button / script / switch** entities (Tapo Control, Reolink, AiDot, …) or directly with **ONVIF** (`onvif.ptz`).

> **Heads-up:** This card was vibe coded. I needed a simple, good-looking PTZ control for my own cameras, couldn't find one, and figured others might want it too, so here it is for everyone. It works well for me, but it's a small hobby project, not a polished product. Issues and pull requests are welcome.

## Installation

### HACS (recommended)

1. HACS → ⋮ → **Custom repositories**
2. Add `https://github.com/freudanderror/ptz-dpad-card` with type **Dashboard**
3. Install **PTZ D-Pad Card** and reload your browser (clear the cache)

### Manual

1. Copy `ptz-dpad-card.js` to `/config/www/`
2. Settings → Dashboards → ⋮ → Resources → add `/local/ptz-dpad-card.js` as **JavaScript module**
   (the Resources menu only appears with *Advanced mode* enabled in your user profile)
3. Reload your browser

## Quick start (auto-detection)

```yaml
type: custom:ptz-dpad-card
camera: camera.my_camera
```

The card looks for buttons or scripts named up/down/left/right (English or German) in the entity ID, translation key or friendly name. It searches in this order:

1. entities on the **same device** as the camera
2. entities sharing the camera's **base name** (`camera.my_camera` or `camera.my_camera_hd_stream` → `button.my_camera_*`), which also works when the camera entity comes from a different integration such as Frigate
3. entities in the **same area**

This matches the **Tapo Control** integration out of the box. A `calibrate` button is mapped to the center automatically. For ONVIF cameras without such buttons, `onvif.ptz` is used.

If nothing is detected, set `debug: true` and check the browser console (F12), or map the entities manually.

## Manual mapping

```yaml
type: custom:ptz-dpad-card
name: My Camera
up: button.my_camera_move_up
down: button.my_camera_move_down
left: button.my_camera_move_left
right: button.my_camera_move_right
center: button.my_camera_calibrate
```

Each direction can also be an action:

```yaml
type: custom:ptz-dpad-card
camera: camera.my_camera
left:
  action: perform-action
  perform_action: onvif.ptz
  target: { entity_id: camera.my_camera }
  data: { pan: LEFT, move_mode: ContinuousMove, continuous_duration: 0.5 }
stop: button.my_camera_ptz_stop   # pressed when you release the button
```

## Options

| Option | Default | Description |
|---|---|---|
| `camera` | – | Camera entity, used for auto-detection and the title |
| `name` | camera name | Title; `show_name: false` hides it |
| `up` `down` `left` `right` `center` | auto | Entity ID or action (see above) |
| `stop` | auto | Run on release (`stop_on_release: false` to disable) |
| `repeat_interval` | `0` | ms, repeats the command while the button is held |
| `mode` | auto | Force `entity` or `onvif` |
| `onvif_speed` / `onvif_duration` | `0.5` / `0.4` | ONVIF mode only |
| `debug` | `false` | Logs the detected entities to the browser console |
| `size` | `220` | Maximum width in px |
| `arrow_color` `ring_color` `center_color` | theme | Colors, e.g. `"#3a86de"` |

Theme variables: `--ptz-arrow-color`, `--ptz-ring-color`, `--ptz-center-color`.

The card has a visual editor (Edit dashboard → Add card → "PTZ D-Pad Card").

## Tip: place it under the live view

```yaml
type: vertical-stack
cards:
  - type: picture-entity
    entity: camera.my_camera
    camera_view: live
    show_state: false
  - type: custom:ptz-dpad-card
    camera: camera.my_camera
    show_name: false
    size: 180
```

## License

MIT
