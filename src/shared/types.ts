export interface WindowRect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface Bar {
  x1: number
  x2: number
  y: number
}

export interface Scene {
  bar?: Bar
  windows: WindowRect[]
  active?: WindowRect // the window you're using right now
}

export type SnowCommand =
  { type: 'snowing'; value: boolean } | { type: 'rate'; value: number } | { type: 'clear' } | { type: 'focus'; value: boolean } | { type: 'refill' }
  | { type: 'opacity'; value: number } // 0 = invisible, 1 = fully visible

export interface SnowAPI {
  onScene(callback: (scene: Scene) => void): () => void // returns an unsubscribe
  onCmd(callback: (command: SnowCommand) => void): () => void
  setIgnore(ignore: boolean): void
  sendCmd(command: SnowCommand): void // settings window → main → snow window
  quit(): void
}
