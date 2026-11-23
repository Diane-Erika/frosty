import { SnowWorld } from './engine/SnowWorld'

const canvas = document.getElementById('snow') as HTMLCanvasElement
const world = new SnowWorld(canvas, {rate:3})

window.addEventListener('resize', () => world.resize())
const unsubscribeScene = window.snowAPI.onScene((scene) => world.setScene(scene))
const unsubscribeCommand = window.snowAPI.onCmd((command) => world.command(command))

world.start()

// When the page hot-reloads, stop this copy so two loops never run at once
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    world.stop()
    unsubscribeScene()
    unsubscribeCommand()
  })
}