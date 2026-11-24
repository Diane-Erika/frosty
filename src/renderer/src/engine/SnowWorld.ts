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


const CELL = 3 // width of one snow column, in pixels
const GRAVITY = 1600         // pixels per second², pulling things down
const PARTICLE_MASS = 1.4    // how much snow one loose particle carries
const MAX_PARTICLES = 6000   // safety limit so the app never slows to a crawl


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
  }

  clear(): void {
    this.flakes = []
    this.particles = []
    for (const surface of this.surfaces.values()) {
      surface.spillLeft = 0
      surface.spillRight = 0
    }
  }

    private step(deltaTime: number): void {
    this.time += deltaTime
    this.applyScene(deltaTime)
    this.updateFlakes(deltaTime)
    this.updateParticles(deltaTime)

    for (const surface of this.surfaces.values()) this.relax(surface)
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


  private draw(): void {
    const context = this.context
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0)
    context.clearRect(0, 0, this.width, this.height)

    for (const surface of this.surfaces.values()) this.drawSurface(surface)

    this.drawSnowDots(this.flakes)
    this.drawSnowDots(this.particles)
  }
}