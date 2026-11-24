import { SnowWorld } from './engine/SnowWorld'

const canvas = document.getElementById('snow') as HTMLCanvasElement
const world = new SnowWorld(canvas, {rate:3})

window.addEventListener('resize', () => world.resize())
const unsubscribeScene = window.snowAPI.onScene((scene) => world.setScene(scene))
const unsubscribeCommand = window.snowAPI.onCmd((command) => world.command(command))

let ignoringMouse = true // start with clicks passing through

function updateMouseMode(x: number, y: number): void {
  const wantMouse = world.hitTest(x, y) // over snow or a ball, or holding one
  const shouldIgnore = !wantMouse
  if (shouldIgnore !== ignoringMouse) { // only tell main when it changes
    ignoringMouse = shouldIgnore
    window.snowAPI.setIgnore(shouldIgnore)
  }
  canvas.style.cursor = world.isHolding() ? 'grabbing' : wantMouse ? 'grab' : ''
}

window.addEventListener('mousemove', (event) => {
  world.pointerMove(event.clientX, event.clientY)
  updateMouseMode(event.clientX, event.clientY)
})
window.addEventListener('mousedown', (event) => {
  world.pointerDown(event.clientX, event.clientY)
  updateMouseMode(event.clientX, event.clientY)
})
window.addEventListener('mouseup', (event) => {
  world.pointerUp()
  updateMouseMode(event.clientX, event.clientY)
})
document.addEventListener('mouseleave', () => {
  if (!world.isHolding() && !ignoringMouse) {
    ignoringMouse = true
    window.snowAPI.setIgnore(true)
  }
})

world.start()

// When the page hot-reloads, stop this copy so two loops never run at once
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    world.stop()
    unsubscribeScene()
    unsubscribeCommand()
  })
}