import type { Scene, SnowCommand } from '../../../shared/types'

interface Flake {
  x: number
  y: number
  fallSpeed: number // pixels per second, downward
  radius: number
  phase: number     // where this flake is in its side-to-side sway
  mass: number      // how much snow it adds when it lands (used in the next step)
}

interface Surface {
  id: string
  x1: number            // left edge
  y: number             // the line snow sits on (window top or taskbar top)
  cellCount: number
  heights: Float32Array // snow height in each cell
  visible: Uint8Array   // 1 = cell can hold snow, 0 = covered by another window (Step 9)
  maxHeight: Float32Array     // snow stops piling up past this height
  spillLeft: number     // snow sliding off the left edge (Step 8)
  spillRight: number    // snow sliding off the right edge (Step 8)
}

interface Particle {
  x: number
  y: number
  velocityX: number // pixels per second
  velocityY: number // pixels per second (positive = down)
  mass: number
  radius: number
}

interface Landing {
  surface: Surface
  cell: number
}

interface Speck {
  angle: number    // where it sits around the ball
  distance: number // how far from the center (0 = center, 1 = edge)
  size: number
}

interface Ball {
  x: number
  y: number
  previousX: number // position before this physics step
  previousY: number
  velocityX: number
  velocityY: number
  radius: number
  rollAngle: number            // how far it has rolled, so the specks turn
  restingOn: string | null     // a surface id, 'floor', or null when in the air
  thrown: boolean
  specks: Speck[]              // little texture dots, so you can see it roll
  restingOnBall: Ball | null // the ball this one sits on, if any
  carryX: number             // how far a moving window carried it this frame
  carryY: number
  dead: boolean // burst this frame, about to be removed
}

interface PointerSample {
  x: number
  y: number
  time: number // milliseconds
}

interface Dust {
  x: number
  y: number
  velocityX: number
  velocityY: number
  age: number    // seconds since it appeared
  life: number   // seconds until it's gone
  radius: number
}


const CELL = 3 // width of one snow column, in pixels
const GRAVITY = 1600         // pixels per second², pulling things down
const PARTICLE_MASS = 1.4    // how much snow one loose particle carries
const MAX_PARTICLES = 6000   // safety limit so the app never slows to a crawl
const MAX_BALL_RADIUS = 72
const BREAK_SPEED = 520 // impact speed (px/s) that bursts a thrown ball

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

// A different height limit for each strip, rising and falling in gentle waves
function makeWavyLimits(cellCount: number, maxHeight: number): Float32Array {
  const limits = new Float32Array(cellCount)
  const phaseA = randomBetween(0, Math.PI * 2) // random start, so every window looks different
  const phaseB = randomBetween(0, Math.PI * 2)
  for (let cell = 0; cell < cellCount; cell++) {
    const wave = Math.sin(cell * 0.06 + phaseA) * 0.6 + Math.sin(cell * 0.17 + phaseB) * 0.4 // -1 to 1
    limits[cell] = maxHeight * (0.7 + 0.3 * wave) // between 40% and 100% of maxHeight
  }
  return limits
}

export class SnowWorld {
  snowing = true
  rate = 1
  focusMode = false
  flakeOpacity = 1 // how see-through falling flakes are (0 to 1)

  private canvas: HTMLCanvasElement
  private context: CanvasRenderingContext2D
  private width = 0
  private height = 0
  private pixelRatio = 1
  private time = 0
  private spawnAccumulator = 0
  private flakes: Flake[] = []
  private animationFrameId: number | null = null
  private lastFrameTime = 0

  private scene: Scene | null = null
  private surfaces = new Map<string, Surface>()
  private seeded = false

  private particles: Particle[] = []

  private balls: Ball[] = []
  private heldBall: Ball | null = null
  private holdOffsetX = 0 // where on the ball you grabbed it
  private holdOffsetY = 0
  private pointerX = 0
  private pointerY = 0
  private pointerSamples: PointerSample[] = [] // recent mouse positions, for throwing

  private dust: Dust[] = []
  
  constructor(canvas: HTMLCanvasElement, options: { rate?: number } = {}) {
    this.canvas = canvas
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Canvas 2D is not supported')
    this.context = context
    if (options.rate !== undefined) this.rate = options.rate
    this.resize()
  }

    resize(): void {
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 2)
    this.width = this.canvas.clientWidth
    this.height = this.canvas.clientHeight
    this.canvas.width = Math.round(this.width * this.pixelRatio)
    this.canvas.height = Math.round(this.height * this.pixelRatio)
  }

  start(): void {
    if (this.animationFrameId !== null) return // already running
    this.lastFrameTime = performance.now()
    const loop = (now: number): void => {
      const deltaTime = Math.min(0.033, (now - this.lastFrameTime) / 1000)
      this.lastFrameTime = now
      this.step(deltaTime)
      this.animationFrameId = requestAnimationFrame(loop)
    }
    this.animationFrameId = requestAnimationFrame(loop)
  }

  stop(): void {
    if (this.animationFrameId !== null) cancelAnimationFrame(this.animationFrameId)
    this.animationFrameId = null
  }

    setScene(scene: Scene): void {
        this.scene = scene
  }

  command(command: SnowCommand): void {
    if (command.type === 'snowing') this.snowing = command.value
    else if (command.type === 'rate') this.rate = command.value
    else if (command.type === 'clear') this.clear()
    else if (command.type === 'refill') this.refill()
    else if (command.type === 'focus') this.focusMode = command.value
    else if (command.type === 'opacity') this.flakeOpacity = command.value
  }

  clear(): void {
    this.flakes = []
    this.particles = []
    this.balls = []
    this.heldBall = null
    this.dust = [] 
    for (const surface of this.surfaces.values()) {
      surface.spillLeft = 0
      surface.spillRight = 0
    }
  }

  refill(): void {
    for (const surface of this.surfaces.values()) {
      for (let cell = 0; cell < surface.cellCount; cell++) {
        if (surface.visible[cell]) surface.heights[cell] = surface.maxHeight[cell]
      }
    }
  }

  private insideActiveWindow(x: number, y: number): boolean {
    const active = this.scene?.active
    if (!this.focusMode || !active) return false
    return x >= active.x && x <= active.x + active.w && y >= active.y && y <= active.y + active.h
  }

  private step(deltaTime: number): void {
    this.time += deltaTime

     for (const ball of this.balls) {
      ball.carryX = 0
      ball.carryY = 0
    }
    this.applyScene(deltaTime)
    this.carryStacks()
    this.updateFlakes(deltaTime)
    this.updateParticles(deltaTime)
    this.updateDust(deltaTime)

    for (const surface of this.surfaces.values()) this.relax(surface)
    
    this.updateBalls(deltaTime / 2) // two smaller steps are more stable than one big one
    this.updateBalls(deltaTime / 2)
    this.draw()
  }

  private spawnFlake(): void {
    const size = Math.random() // 0 = small and slow, 1 = big and fast
    this.flakes.push({
      x: randomBetween(-40, this.width + 40),
      y: -6,
      fallSpeed: randomBetween(45, 95) * (0.7 + size * 0.6),
      radius: 0.8 + size * 1.8,
      phase: randomBetween(0, Math.PI * 2),
      mass: 0.22 + size * 0.18
    })
  }

  private updateFlakes(deltaTime: number): void {
    if (this.snowing) {
      this.spawnAccumulator += (deltaTime * this.rate * this.width) / 14
      while (this.spawnAccumulator >= 1) {
        this.spawnAccumulator -= 1
        this.spawnFlake()
      }
    }

    const wind = Math.sin(this.time * 0.13) * 18 + Math.sin(this.time * 0.041) * 10

    for (let index = this.flakes.length - 1; index >= 0; index--) {
      const flake = this.flakes[index]
      const previousY = flake.y
      flake.y += flake.fallSpeed * deltaTime
      const sway = Math.sin(this.time * 1.3 + flake.phase) * 14
      flake.x += (wind + sway) * deltaTime * (0.6 + flake.radius * 0.2)

      const landing = this.findLanding(flake.x, previousY, flake.y)
      if (landing) {
        this.deposit(landing.surface, landing.cell, flake.mass)
        this.flakes.splice(index, 1)
      } else if (flake.y > this.height + 5) {
        this.flakes.splice(index, 1)
      }
    }
  }

  private applyScene(deltaTime: number): void {
    const scene = this.scene
    if (!scene) return
    const activeIds = new Set<string>()
    const barY = scene.bar ? scene.bar.y : this.height

    if (scene.bar) {
      this.updateSurface('bar', scene.bar.x1, scene.bar.x2, scene.bar.y, 24, deltaTime)
      activeIds.add('bar')
    }

    for (let windowIndex = 0; windowIndex < scene.windows.length; windowIndex++) {
      const win = scene.windows[windowIndex]
      const tooLow = win.y >= barY - 6
      const aboveScreen = win.y < -5
      const tooNarrow = win.w < 60
      if (tooLow || aboveScreen || tooNarrow) continue

      const id = 'w' + win.id
      const surface = this.updateSurface(id, win.x, win.x + win.w, win.y, 14, deltaTime)
      activeIds.add(id)

      // Windows earlier in the list are in front of this one
      const coveredRanges: [number, number][] = []
      for (let frontIndex = 0; frontIndex < windowIndex; frontIndex++) {
        const front = scene.windows[frontIndex]
        const coversTopEdge = front.y < win.y + 2 && front.y + front.h > win.y - 6
        if (coversTopEdge) coveredRanges.push([front.x, front.x + front.w])
      }
      this.applyCovering(surface, coveredRanges)
    }

    // Closed or minimized windows: drop all their snow, then remove the surface
    for (const [id, surface] of this.surfaces) {
      if (activeIds.has(id)) continue
      this.shedFraction(surface, 1, 0, 0, 3)
        
      for (const ball of this.balls) {
        if (ball.restingOn === id) {
          ball.restingOn = null
          ball.velocityY = Math.min(ball.velocityY, 0)
        }
      }

      this.surfaces.delete(id)
    }

    if (!this.seeded && this.surfaces.size > 0) {
      this.seedSnow()
      this.seeded = true
    }
  }

    private updateSurface(id: string, left: number, right: number, lineY: number,
                        maxHeight: number, deltaTime: number): Surface {
    const cellCount = Math.max(1, Math.round((right - left) / CELL))
    let surface = this.surfaces.get(id)

    // New window: create an empty surface right where it is
    if (!surface) {
      surface = {
        id, x1: left, y: lineY, cellCount,
        heights: new Float32Array(cellCount),
        visible: new Uint8Array(cellCount).fill(1),
        maxHeight: makeWavyLimits(cellCount, maxHeight),
        spillLeft: 0, spillRight: 0
      }
      this.surfaces.set(id, surface)
      return surface
    }

    // 1. Glide toward the real position instead of jumping
    const previousX = surface.x1
    const previousY = surface.y
    const follow = Math.min(1, deltaTime * 20) // about 1/3 of the remaining distance per frame
    surface.x1 += (left - surface.x1) * follow
    surface.y += (lineY - surface.y) * follow
    if (Math.abs(left - surface.x1) < 0.3) surface.x1 = left // close enough: snap
    if (Math.abs(lineY - surface.y) < 0.3) surface.y = lineY

    // 2. Moving fast? Shake some snow off
    const safeTime = Math.max(deltaTime, 0.001) // avoid dividing by zero
    const velocityX = (surface.x1 - previousX) / safeTime
    const velocityY = (surface.y - previousY) / safeTime
    const speed = Math.hypot(velocityX, velocityY)
    if (speed > 1400) {
      this.shedFraction(surface, Math.min(0.5, deltaTime * 7), velocityX, velocityY, 2.5) // very fast: lots
    } else if (speed > 650) {
      this.shedFraction(surface, deltaTime * 1.5, velocityX, velocityY, 2) // fast: a little
    }

    // Balls resting on this window move with it, unless it's moving really fast
    const movedX = surface.x1 - previousX
    const movedY = surface.y - previousY
    for (const ball of this.balls) {
      if (ball.restingOn !== id || ball === this.heldBall) continue
      if (speed > 1500) {
        ball.restingOn = null // knocked off
        ball.velocityX += velocityX * 0.6
        ball.velocityY += velocityY * 0.3 - 120
      } else {
        ball.x += movedX
        ball.y += movedY
        ball.carryX += movedX
        ball.carryY += movedY
      }
    }

    // 3. Resized? Keep what fits, drop the rest
    if (cellCount !== surface.cellCount) {
      for (let cell = cellCount; cell < surface.cellCount; cell++) {
        if (surface.heights[cell] > 0) this.emitSnow(surface, cell, surface.heights[cell], 0, 0, 2.5)
      }
      const heights = new Float32Array(cellCount)
      heights.set(surface.heights.subarray(0, Math.min(cellCount, surface.cellCount)))
      surface.heights = heights
      surface.visible = new Uint8Array(cellCount).fill(1)
      surface.maxHeight = makeWavyLimits(cellCount, maxHeight)
      surface.cellCount = cellCount
    }

    return surface
  }

  // Start with a little wavy snow so it doesn't look empty on launch
  private seedSnow(): void {
    for (const surface of this.surfaces.values()) {
      const base = surface.id === 'bar' ? 13 : 4
      for (let cell = 0; cell < surface.cellCount; cell++) {
        if (!surface.visible[cell]) continue
        surface.heights[cell] =
          base + Math.sin(cell * 0.11) * base * 0.25 + Math.sin(cell * 0.37 + 2) * base * 0.12
      }
    }
  }

    // Did something moving from previousY to newY at x just hit snow? Returns the highest hit.
  private findLanding(x: number, previousY: number, newY: number): Landing | null {
    let best: Landing | null = null
    let bestTop = Infinity
    for (const surface of this.surfaces.values()) {
      const cell = Math.floor((x - surface.x1) / CELL)
      if (cell < 0 || cell >= surface.cellCount || !surface.visible[cell]) continue
      const top = surface.y - surface.heights[cell]
      const crossedTop = previousY <= top + 0.5 && newY >= top
      if (crossedTop && top < bestTop) {
        best = { surface, cell }
        bestTop = top
      }
    }
    return best
  }

  // Add snow to a cell, with a little going to each neighbour
  private deposit(surface: Surface, cell: number, mass: number): void {
    const heights = surface.heights
    if (heights[cell] >= surface.maxHeight[cell]) return // full: the snow is lost
    heights[cell] += 0.6 * mass
    for (const neighbour of [cell - 1, cell + 1]) {
      const usable = neighbour >= 0 && neighbour < surface.cellCount && surface.visible[neighbour]
      if (usable) heights[neighbour] += 0.2 * mass
      else heights[cell] += 0.2 * mass
    }
  }

    // Find each stretch of cells that has snow, and draw it
  private drawSurface(surface: Surface): void {
    const hasSnow = (cell: number): boolean =>
      surface.visible[cell] === 1 && surface.heights[cell] >= 0.25

    let cell = 0
    while (cell < surface.cellCount) {
      if (!hasSnow(cell)) {
        cell++
        continue
      }
      const firstCell = cell
      while (cell < surface.cellCount && hasSnow(cell)) cell++
      this.drawSnowRun(surface, firstCell, cell - 1)
    }
  }

  private drawSnowRun(surface: Surface, firstCell: number, lastCell: number): void {
    const context = this.context
    const { heights, x1, y } = surface
    const centerX = (cell: number): number => x1 + (cell + 0.5) * CELL
    const topY = (cell: number): number => y - heights[cell]
    const leftX = x1 + firstCell * CELL
    const rightX = x1 + (lastCell + 1) * CELL

    let tallest = 0
    for (let cell = firstCell; cell <= lastCell; cell++) tallest = Math.max(tallest, heights[cell])

    context.beginPath()
    context.moveTo(leftX, y)                                  // bottom-left
    context.lineTo(leftX, y - heights[firstCell] * 0.55)      // rounded left shoulder
    context.lineTo(centerX(firstCell), topY(firstCell))
    for (let cell = firstCell + 1; cell < lastCell; cell++) { // smooth curve along the top
      const midX = (centerX(cell) + centerX(cell + 1)) / 2
      const midY = (topY(cell) + topY(cell + 1)) / 2
      context.quadraticCurveTo(centerX(cell), topY(cell), midX, midY)
    }
    context.lineTo(centerX(lastCell), topY(lastCell))
    context.lineTo(rightX, y - heights[lastCell] * 0.55)      // rounded right shoulder
    context.lineTo(rightX, y)                                 // bottom-right
    context.closePath()

    const gradient = context.createLinearGradient(0, y - tallest, 0, y)
    gradient.addColorStop(0, '#ffffff') // white on top
    gradient.addColorStop(1, '#dbe6f3') // light blue-grey at the bottom
    context.fillStyle = gradient
    context.fill()
    context.strokeStyle = 'rgba(140,160,190,.45)' // thin outline, so snow shows up on white title bars
    context.lineWidth = 1
    context.stroke()
  }

  // particles
  private addParticle(x: number, y: number, velocityX: number, velocityY: number,
    mass: number, radius = 0.9 + Math.sqrt(mass) * 0.6): void {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift() // drop the oldest
    this.particles.push({ x, y, velocityX, velocityY, mass, radius })
  }

  private updateParticles(deltaTime: number): void {
    for (let index = this.particles.length - 1; index >= 0; index--) {
      const particle = this.particles[index]
      particle.velocityY += GRAVITY * 0.75 * deltaTime // gravity speeds it up
      particle.velocityX *= 1 - deltaTime * 0.8        // air slows its sideways motion

      const previousY = particle.y
      particle.x += particle.velocityX * deltaTime
      particle.y += particle.velocityY * deltaTime

      const landing = this.findLanding(particle.x, previousY, particle.y)
      const offScreen = particle.y > this.height + 5 || particle.x < -20 || particle.x > this.width + 20

      if (landing) {
        this.deposit(landing.surface, landing.cell, particle.mass)
        this.particles.splice(index, 1)
      } else if (offScreen) {
        this.particles.splice(index, 1)
      }
    }
  }

    private relax(surface: Surface): void {
    const { heights, visible, cellCount } = surface
    const maxStep = CELL * 0.85 // tallest allowed step between neighbouring strips

    // 1. Sliding: too-steep steps move some snow downhill
    for (let pass = 0; pass < 2; pass++) {
      for (let cell = 0; cell < cellCount - 1; cell++) {
        if (!visible[cell] || !visible[cell + 1]) continue
        const difference = heights[cell] - heights[cell + 1]
        if (difference > maxStep) {
          const amount = (difference - maxStep) * 0.3
          heights[cell] -= amount
          heights[cell + 1] += amount
        } else if (difference < -maxStep) {
          const amount = (-difference - maxStep) * 0.3
          heights[cell + 1] -= amount
          heights[cell] += amount
        }
      }
    }

    // 2. Spilling: deep snow at an edge slowly falls off
    const spillLimit = maxStep * 1.6
    for (let cell = 0; cell < cellCount; cell++) {
      if (!visible[cell] || heights[cell] <= spillLimit) continue
      const isLeftEdge = cell === 0 || !visible[cell - 1]
      const isRightEdge = cell === cellCount - 1 || !visible[cell + 1]
      if (!isLeftEdge && !isRightEdge) continue

      const amount = (heights[cell] - spillLimit) * 0.15
      heights[cell] -= amount
      const snowTop = surface.y - heights[cell]

      if (isLeftEdge) {
        surface.spillLeft += amount
        if (surface.spillLeft > PARTICLE_MASS) {
          surface.spillLeft -= PARTICLE_MASS
          const edgeX = surface.x1 + cell * CELL - 1
          this.addParticle(edgeX, snowTop, -randomBetween(10, 45), 0, PARTICLE_MASS, 1.6)
        }
      } else {
        surface.spillRight += amount
        if (surface.spillRight > PARTICLE_MASS) {
          surface.spillRight -= PARTICLE_MASS
          const edgeX = surface.x1 + (cell + 1) * CELL + 1
          this.addParticle(edgeX, snowTop, randomBetween(10, 45), 0, PARTICLE_MASS, 1.6)
        }
      }
    }
  }

  private drawSnowDots(dots: { x: number; y: number; radius: number }[]): void {
    const context = this.context

    context.fillStyle = 'rgba(120,140,170,.35)'
    for (const dot of dots) {
      const half = dot.radius / 2
      context.fillRect(dot.x - half + 0.6, dot.y - half + 0.6, dot.radius, dot.radius)
    }

    context.fillStyle = '#ffffff'
    context.beginPath()
    for (const dot of dots) {
      const dotRadius = dot.radius * 0.6
      context.moveTo(dot.x + dotRadius, dot.y)
      context.arc(dot.x, dot.y, dotRadius, 0, Math.PI * 2)
    }
    context.fill()
  }

  // window snow fall 
    // Turn `amount` of snow from one strip into falling particles
  private emitSnow(surface: Surface, cell: number, amount: number,
                   velocityX: number, velocityY: number, chunkSize = PARTICLE_MASS): void {
    const count = Math.max(1, Math.round(amount / chunkSize))
    const massEach = amount / count
    const cellCenterX = surface.x1 + (cell + 0.5) * CELL
    for (let piece = 0; piece < count; piece++) {
      this.addParticle(
        cellCenterX + randomBetween(-1.2, 1.2),
        surface.y - surface.heights[cell] * Math.random() - 1, // somewhere inside the pile
        velocityX * 0.5 + randomBetween(-30, 30),              // half the window's speed, plus scatter
        velocityY * 0.5 + randomBetween(-50, 10),              // a little upward pop
        massEach
      )
    }
  }

  // Shake off a fraction (0 to 1) of every strip's snow
  private shedFraction(surface: Surface, fraction: number,
                       velocityX: number, velocityY: number, chunkSize: number): void {
    for (let cell = 0; cell < surface.cellCount; cell++) {
      const amount = surface.heights[cell] * fraction
      if (amount <= 0.2) continue // too little to bother
      this.emitSnow(surface, cell, amount, velocityX, velocityY, chunkSize)
      surface.heights[cell] -= amount
    }
  }

    // Switch off strips that another window covers, dropping their snow
  private applyCovering(surface: Surface, coveredRanges: [number, number][]): void {
    surface.visible.fill(1)
    for (const [rangeStart, rangeEnd] of coveredRanges) {
      const firstCell = Math.max(0, Math.floor((rangeStart - surface.x1) / CELL))
      const lastCell = Math.min(surface.cellCount - 1, Math.floor((rangeEnd - surface.x1) / CELL))
      for (let cell = firstCell; cell <= lastCell; cell++) {
        surface.visible[cell] = 0
        if (surface.heights[cell] > 0) {
          this.emitSnow(surface, cell, surface.heights[cell], 0, 0, 2.5)
          surface.heights[cell] = 0
        }
      }
    }
  }

  // snow ball 

    isHolding(): boolean {
    return this.heldBall !== null
  }

  hitTest(x: number, y: number): boolean {
      if (!this.isHolding() && this.insideActiveWindow(x, y)) return false
    return this.isHolding() || this.ballAt(x, y) !== null || this.snowAt(x, y) !== null
  }

  // The ball under the mouse (checking the last-drawn, top-most ball first)
  private ballAt(x: number, y: number): Ball | null {
    for (let index = this.balls.length - 1; index >= 0; index--) {
      const ball = this.balls[index]
      if (Math.hypot(x - ball.x, y - ball.y) <= ball.radius + 4) return ball
    }
    return null
  }

  // Snow under the mouse that's deep enough (2 px or more) to scoop
  private snowAt(x: number, y: number): Landing | null {
    let best: Landing | null = null
    let bestTop = Infinity
    for (const surface of this.surfaces.values()) {
      const cell = Math.floor((x - surface.x1) / CELL)
      if (cell < 0 || cell >= surface.cellCount || !surface.visible[cell]) continue
      const snowHeight = surface.heights[cell]
      if (snowHeight < 2) continue
      const top = surface.y - snowHeight
      const insidePile = y >= top - 8 && y <= surface.y - 1 // a little forgiving above the pile
      if (insidePile && top < bestTop) {
        best = { surface, cell }
        bestTop = top
      }
    }
    return best
  }

    pointerDown(x: number, y: number): boolean {
    this.pointerX = x
    this.pointerY = y
    this.pointerSamples = [{ x, y, time: performance.now() }]

    const ball = this.ballAt(x, y)
    if (ball) {
      this.holdBall(ball, ball.x - x, ball.y - y)
      return true
    }

    const spot = this.snowAt(x, y)
    if (spot) {
      const newBall = this.scoopBall(spot, x)
      this.holdBall(newBall, 0, newBall.y - y)
      return true
    }
    return false
  }

  pointerMove(x: number, y: number): void {
    this.pointerX = x
    this.pointerY = y
    this.pointerSamples.push({ x, y, time: performance.now() })
    if (this.pointerSamples.length > 10) this.pointerSamples.shift() // keep only the last 10
  }

  pointerUp(): void {
    const ball = this.heldBall
    if (!ball) return
    this.heldBall = null

    // Throw speed = how far the mouse moved in its last ~80 ms
    let velocityX = 0
    let velocityY = 0
    const latest = this.pointerSamples[this.pointerSamples.length - 1]
    const stillMoving = latest && performance.now() - latest.time <= 120
    if (stillMoving) {
      const oldest = this.pointerSamples.find((sample) => latest.time - sample.time <= 80) ?? latest
      const seconds = Math.max(0.016, (latest.time - oldest.time) / 1000)
      velocityX = (latest.x - oldest.x) / seconds
      velocityY = (latest.y - oldest.y) / seconds
    }

    const speed = Math.hypot(velocityX, velocityY)
    if (speed > 2600) { // cap it so balls can't fly impossibly fast
      velocityX *= 2600 / speed
      velocityY *= 2600 / speed
    }
    ball.velocityX = velocityX
    ball.velocityY = velocityY
    ball.thrown = Math.min(speed, 2600) > 450
  }

  private holdBall(ball: Ball, offsetX: number, offsetY: number): void {
    this.heldBall = ball
    this.holdOffsetX = offsetX
    this.holdOffsetY = offsetY
    ball.thrown = false
  }

  private scoopBall(spot: Landing, x: number): Ball {
    const { surface, cell } = spot
    let taken = 0
    for (let near = cell - 4; near <= cell + 4; near++) {
      if (near < 0 || near >= surface.cellCount || !surface.visible[near]) continue
      const take = Math.min(surface.heights[near], 5 - Math.abs(near - cell) * 0.6) // most from the middle
      surface.heights[near] -= take
      taken += take
    }
    const radius = Math.max(4, Math.sqrt((taken * CELL) / Math.PI))
    const ballY = surface.y - surface.heights[cell] * 0.75 - radius
    const ball = this.createBall(x, ballY, radius)
    this.balls.push(ball)
    return ball
  }

  private createBall(x: number, y: number, radius: number): Ball {
    const specks: Speck[] = []
    for (let index = 0; index < 7; index++) {
      specks.push({
        angle: randomBetween(0, Math.PI * 2),
        distance: randomBetween(0.25, 0.85),
        size: randomBetween(0.04, 0.08)
      })
    }
    return {
      x, y, previousX: x, previousY: y, velocityX: 0, velocityY: 0,
      radius, rollAngle: 0, restingOn: null, thrown: false, specks, restingOnBall: null, carryX: 0, carryY: 0,
      dead: false
    }
  }

    private updateBalls(stepTime: number): void {
    for (const ball of this.balls) {
      if (ball.dead) continue

      ball.previousX = ball.x
      ball.previousY = ball.y

      if (ball === this.heldBall) {
        // Follow the mouse like a stiff spring. This velocity becomes the throw.
        const pull = Math.min(1, stepTime * 30)
        ball.velocityX = ((this.pointerX + this.holdOffsetX - ball.x) * pull) / stepTime
        ball.velocityY = ((this.pointerY + this.holdOffsetY - ball.y) * pull) / stepTime
      } else {
        ball.velocityY += GRAVITY * stepTime
        ball.velocityX *= 1 - stepTime * 0.15 // a little air drag
      }

      ball.x += ball.velocityX * stepTime
      ball.y += ball.velocityY * stepTime
      ball.restingOn = null
      ball.restingOnBall = null

      this.collideWithSurfaces(ball, stepTime)
      this.collideWithScreenEdges(ball, stepTime)
    }

    this.solveBallContacts()

    // A thrown ball that has settled down is just a normal ball again
    for (const ball of this.balls) {
      const slow = Math.hypot(ball.velocityX, ball.velocityY) < 250
      if (ball.thrown && slow && ball.restingOn) ball.thrown = false
      if (ball.thrown && slow && (ball.restingOn || ball.restingOnBall)) ball.thrown = false
    }
    
    this.balls = this.balls.filter((ball) => !ball.dead && ball.y < this.height + 300)
  }

  private collideWithSurfaces(ball: Ball, stepTime: number): void {
    const isHeld = ball === this.heldBall
    for (const surface of this.surfaces.values()) {
      const cell = Math.floor((ball.x - surface.x1) / CELL)
      if (cell < 0 || cell >= surface.cellCount || !surface.visible[cell]) continue

      // The deepest snow under the ball's "footprint"
      const reach = Math.ceil((ball.radius * 0.5) / CELL)
      let deepest = 0
      for (let near = cell - reach; near <= cell + reach; near++) {
        if (near >= 0 && near < surface.cellCount && surface.visible[near]) {
          deepest = Math.max(deepest, surface.heights[near])
        }
      }
      const top = surface.y - deepest * 0.75 // the ball sinks 25% into soft snow

      // Only collide if the ball came from above (you can move balls up through windows)
      const cameFromAbove = ball.previousY + ball.radius <= top + 10
      const touching = ball.y + ball.radius > top
      if (!cameFromAbove || !touching) continue

      const impact = ball.velocityY
      ball.y = top - ball.radius
      if (isHeld) {
        ball.velocityY = Math.min(ball.velocityY, 0) // ride on the snow, don't push through
      } else {
        ball.velocityY = impact > 150 ? -impact * 0.15 : 0 // small bounce, or settle
        ball.velocityX *= Math.max(0, 1 - stepTime * 4)    // rolling friction
        
        if (ball.thrown && impact > BREAK_SPEED) {
          this.shatter(ball)
          return
        }
      }
      ball.restingOn = surface.id

      // Rolling picks up snow
      const movedX = ball.x - ball.previousX
      if (Math.abs(movedX) > 0.3) this.collectSnow(ball, surface, cell, movedX)
      ball.rollAngle += movedX / ball.radius
    }
  }

  private collectSnow(ball: Ball, surface: Surface, cell: number, movedX: number): void {
    const span = Math.max(1, Math.floor((ball.radius * 0.7) / CELL))
    let taken = 0
    for (let near = cell - span; near <= cell + span; near++) {
      if (near < 0 || near >= surface.cellCount || !surface.visible[near]) continue
      const take = Math.min(surface.heights[near], Math.abs(movedX) * 0.32)
      surface.heights[near] -= take
      taken += take
    }
    const newArea = ball.radius ** 2 + (taken * CELL) / Math.PI
    ball.radius = Math.min(MAX_BALL_RADIUS, Math.sqrt(newArea))
  }

  private collideWithScreenEdges(ball: Ball, stepTime: number): void {
    const isHeld = ball === this.heldBall

    // Bottom of the screen
    if (ball.y + ball.radius > this.height) {
      const impact = ball.velocityY
      ball.y = this.height - ball.radius
      if (isHeld) {
        ball.velocityY = Math.min(ball.velocityY, 0)
      } else {

          if (ball.thrown && impact > BREAK_SPEED) {
            this.shatter(ball)
            return
          }

        ball.velocityY = impact > 150 ? -impact * 0.15 : 0
        ball.velocityX *= Math.max(0, 1 - stepTime * 4)
      }
      ball.restingOn = 'floor'
      ball.rollAngle += (ball.x - ball.previousX) / ball.radius
    }

    // Left and right sides: bounce back softly
    if (ball.x - ball.radius < 0) {
      if (ball.thrown && -ball.velocityX > BREAK_SPEED) {
        this.shatter(ball)
        return
      }
      ball.x = ball.radius
      if (ball.velocityX < 0) ball.velocityX = -ball.velocityX * 0.3
    }
    if (ball.x + ball.radius > this.width) {
       if (ball.thrown && ball.velocityX > BREAK_SPEED) {
        this.shatter(ball)
        return
      }
      ball.x = this.width - ball.radius
      if (ball.velocityX > 0) ball.velocityX = -ball.velocityX * 0.3
    }
  }

  private drawBall(ball: Ball): void {
    const context = this.context
    const { x, y, radius } = ball

    // Shading: brightest at the top-left, as if lit from there
    const gradient = context.createRadialGradient(
      x - radius * 0.35, y - radius * 0.4, radius * 0.1,
      x, y, radius
    )
    gradient.addColorStop(0, '#ffffff')
    gradient.addColorStop(0.7, '#f1f5fb')
    gradient.addColorStop(1, '#d4dfee')
    context.fillStyle = gradient
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fill()
    context.strokeStyle = 'rgba(130,150,185,.5)'
    context.lineWidth = 1
    context.stroke()

    // Specks turn with the ball so you can see it roll
    context.fillStyle = 'rgba(150,170,200,.35)'
    for (const speck of ball.specks) {
      const angle = speck.angle + ball.rollAngle
      const speckX = x + Math.cos(angle) * speck.distance * radius
      const speckY = y + Math.sin(angle) * speck.distance * radius
      context.beginPath()
      context.arc(speckX, speckY, Math.max(0.8, speck.size * radius), 0, Math.PI * 2)
      context.fill()
    }
  }

    // Balls sitting on other balls move along with whatever is under them
  private carryStacks(): void {
    const bottomFirst = [...this.balls].sort((first, second) => second.y - first.y)
    for (const ball of bottomFirst) {
      const support = ball.restingOnBall
      if (!support || ball === this.heldBall) continue
      ball.x += support.carryX
      ball.y += support.carryY
      ball.carryX += support.carryX // pass it on to the ball above this one
      ball.carryY += support.carryY
    }
  }

     private solveBallContacts(): void {
    const bottomFirst = [...this.balls].sort((first, second) => second.y - first.y)
    for (let round = 0; round < 3; round++) {
      for (let lowerIndex = 0; lowerIndex < bottomFirst.length; lowerIndex++) {
        for (let upperIndex = lowerIndex + 1; upperIndex < bottomFirst.length; upperIndex++) {
          this.solveContact(bottomFirst[lowerIndex], bottomFirst[upperIndex], round === 0)
        }
      }
    }
  }

  private solveContact(first: Ball, second: Ball, checkBreak: boolean): void {
    if (first.dead || second.dead) return
    const bottom = first.y >= second.y ? first : second
    const top = bottom === first ? second : first
    const offsetX = top.x - bottom.x
    const offsetY = top.y - bottom.y
    const touchDistance = top.radius + bottom.radius
    const distance = Math.hypot(offsetX, offsetY)
    if (distance >= touchDistance || distance === 0) return

    const topHeld = top === this.heldBall
    const normalX = offsetX / distance
    const normalY = offsetY / distance
    const approachSpeed =
      (top.velocityX - bottom.velocityX) * normalX + (top.velocityY - bottom.velocityY) * normalY

    // 0. Hard hit by a thrown ball? Burst.
    if (checkBreak && -approachSpeed > BREAK_SPEED && (top.thrown || bottom.thrown)) {
      if (-approachSpeed > 1.8 * BREAK_SPEED) {
        // Very hard: both burst (except one you're holding)
        if (top !== this.heldBall) this.shatter(top)
        if (bottom !== this.heldBall) this.shatter(bottom)
      } else {
        // Otherwise only the thrown one (or the faster one, if both were thrown)
        const topSpeed = Math.hypot(top.velocityX, top.velocityY)
        const bottomSpeed = Math.hypot(bottom.velocityX, bottom.velocityY)
        let target: Ball
        if (top.thrown && !bottom.thrown) target = top
        else if (bottom.thrown && !top.thrown) target = bottom
        else target = topSpeed >= bottomSpeed ? top : bottom
        if (target !== this.heldBall) this.shatter(target)
      }
      return
    }

    // 1. Stacking
    if (-offsetY > 0.6 * touchDistance) {
      top.y = bottom.y - Math.sqrt(touchDistance ** 2 - offsetX ** 2)
      if (!topHeld) {
        top.velocityY = Math.min(top.velocityY, bottom.velocityY)
        top.velocityX = bottom.velocityX + (top.velocityX - bottom.velocityX) * 0.6
        top.restingOnBall = bottom
      }
      return
    }

    // 2. Side contact
    const massBottom = bottom === this.heldBall ? 1e9 : bottom.radius ** 2
    const massTop = topHeld ? 1e9 : top.radius ** 2
    const totalMass = massBottom + massTop
    const overlap = touchDistance - distance
    bottom.x -= normalX * overlap * (massTop / totalMass)
    bottom.y -= normalY * overlap * (massTop / totalMass)
    top.x += normalX * overlap * (massBottom / totalMass)
    top.y += normalY * overlap * (massBottom / totalMass)
    if (approachSpeed < 0) {
      const impulse = (-approachSpeed * 1.05) / (1 / massBottom + 1 / massTop)
      bottom.velocityX -= (impulse / massBottom) * normalX
      bottom.velocityY -= (impulse / massBottom) * normalY
      top.velocityX += (impulse / massTop) * normalX
      top.velocityY += (impulse / massTop) * normalY
    }
  }

  // snowman 
    private drawFace(ball: Ball): void {
    const context = this.context
    const { x, y, radius } = ball
    context.fillStyle = '#2b2b2b' // coal

    // Eyes
    const eyeRadius = Math.max(1.2, radius * 0.09)
    for (const side of [-1, 1]) {
      context.beginPath()
      context.arc(x + side * 0.3 * radius, y - 0.18 * radius, eyeRadius, 0, Math.PI * 2)
      context.fill()
    }

    // Smile: 5 dots along the bottom of a circle
    const smileCenterY = y - 0.05 * radius
    for (let dot = -2; dot <= 2; dot++) {
      const angle = Math.PI / 2 + dot * 0.32 // π/2 = straight down
      context.beginPath()
      context.arc(
        x + Math.cos(angle) * 0.48 * radius,
        smileCenterY + Math.sin(angle) * 0.48 * radius,
        eyeRadius * 0.6, 0, Math.PI * 2
      )
      context.fill()
    }

    // Carrot nose
    context.fillStyle = '#f08a24'
    context.beginPath()
    context.moveTo(x, y - 0.06 * radius)
    context.lineTo(x + 0.62 * radius, y + 0.06 * radius)
    context.lineTo(x, y + 0.12 * radius)
    context.closePath()
    context.fill()
  }

  private drawButtons(ball: Ball): void {
    const context = this.context
    context.fillStyle = '#2b2b2b'
    for (const offset of [-0.4, 0, 0.4]) {
      context.beginPath()
      context.arc(ball.x, ball.y + offset * ball.radius, Math.max(1.2, ball.radius * 0.08), 0, Math.PI * 2)
      context.fill()
    }
  }

  private drawArms(ball: Ball): void {
    const context = this.context
    const { x, y, radius } = ball
    context.strokeStyle = '#6b4a2f' // wood brown
    context.lineWidth = Math.max(1.5, radius * 0.07)
    context.lineCap = 'round'
    for (const side of [-1, 1]) { // -1 = left arm, 1 = right arm
      const startX = x + side * 0.75 * radius
      const startY = y - 0.25 * radius
      const endX = startX + side * 0.95 * radius
      const endY = startY - 0.55 * radius
      const twigX = startX + (endX - startX) * 0.65 // a small twig 65% along the arm
      const twigY = startY + (endY - startY) * 0.65
      context.beginPath()
      context.moveTo(startX, startY)
      context.lineTo(endX, endY)
      context.moveTo(twigX, twigY)
      context.lineTo(twigX + side * 0.12 * radius, twigY - 0.32 * radius)
      context.stroke()
    }
    context.lineCap = 'butt' // reset, so other drawing isn't affected
  }

    private shatter(ball: Ball): void {
    if (ball.dead) return
    ball.dead = true
    if (ball === this.heldBall) this.heldBall = null

    // Snow particles: the ball's snow, split into pieces
    const totalMass = ((Math.PI * ball.radius ** 2) / CELL) * 0.9
    const count = Math.min(90, Math.max(8, Math.round(totalMass / 3)))
    const massEach = totalMass / count
    for (let piece = 0; piece < count; piece++) {
      const angle = randomBetween(0, Math.PI * 2)
      const distanceFromCenter = Math.sqrt(Math.random()) * ball.radius
      const burstSpeed = randomBetween(60, 340)
      this.addParticle(
        ball.x + Math.cos(angle) * distanceFromCenter,
        ball.y + Math.sin(angle) * distanceFromCenter,
        ball.velocityX * 0.2 + Math.cos(angle) * burstSpeed,
        ball.velocityY * 0.1 + Math.sin(angle) * burstSpeed - 120, // extra upward pop
        massEach,
        0.9 + Math.sqrt(massEach) * 0.55
      )
    }

    // Dust puff: just for looks
    const puffCount = Math.min(40, 10 + ball.radius)
    for (let puff = 0; puff < puffCount; puff++) {
      const angle = randomBetween(0, Math.PI * 2)
      const speed = randomBetween(20, 160)
      this.dust.push({
        x: ball.x + Math.cos(angle) * ball.radius * 0.6,
        y: ball.y + Math.sin(angle) * ball.radius * 0.6,
        velocityX: Math.cos(angle) * speed,
        velocityY: Math.sin(angle) * speed - 40,
        age: 0,
        life: randomBetween(0.35, 0.8),
        radius: randomBetween(2, 3 + ball.radius * 0.12)
      })
    }
  }

  private updateDust(deltaTime: number): void {
    for (let index = this.dust.length - 1; index >= 0; index--) {
      const puff = this.dust[index]
      puff.age += deltaTime
      if (puff.age >= puff.life) {
        this.dust.splice(index, 1)
        continue
      }
      puff.velocityX *= 1 - 3 * deltaTime                        // slows down quickly
      puff.velocityY = puff.velocityY * (1 - 3 * deltaTime) + 60 * deltaTime // and drifts down gently
      puff.x += puff.velocityX * deltaTime
      puff.y += puff.velocityY * deltaTime
    }
  }

  private drawDust(): void {
    const context = this.context
    context.fillStyle = '#ffffff'
    for (const puff of this.dust) {
      context.globalAlpha = 0.75 * (1 - puff.age / puff.life) // fades out
      context.beginPath()
      context.arc(puff.x, puff.y, puff.radius * (1 + 1.5 * puff.age), 0, Math.PI * 2) // grows
      context.fill()
    }
    context.globalAlpha = 1 // reset, so other drawing isn't see-through
  }


   private draw(): void {
    const context = this.context
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0)
    context.clearRect(0, 0, this.width, this.height)

    for (const surface of this.surfaces.values()) this.drawSurface(surface)

    const supporters = new Set<Ball>() // balls that have another ball on top
    for (const ball of this.balls) {
      if (ball.restingOnBall) supporters.add(ball.restingOnBall)
    }
    const heads = new Set<Ball>()
    const bodies = new Set<Ball>()
    for (const ball of this.balls) {
      const isTopOfStack = ball.restingOnBall && !supporters.has(ball)
      if (isTopOfStack) {
        heads.add(ball)
        bodies.add(ball.restingOnBall!)
      }
    }

    for (const body of bodies) this.drawArms(body) // arms first, so they appear behind the ball
    for (const ball of this.balls) {
      this.drawBall(ball)
      if (heads.has(ball)) this.drawFace(ball)
      if (bodies.has(ball)) this.drawButtons(ball)
    }

    context.globalAlpha = this.flakeOpacity
    this.drawSnowDots(this.flakes)
    context.globalAlpha = 1 // reset, so the rest is drawn normally
    this.drawSnowDots(this.particles)
    this.drawDust()

        // Focus mode: erase everything drawn over the active window
    const active = this.scene?.active
    if (this.focusMode && active) context.clearRect(active.x, active.y, active.w, active.h)
  }
}