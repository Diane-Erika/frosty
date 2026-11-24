/// <reference types="vite/client" />
import type { SnowAPI } from "../shared/types"

declare global {
  interface Window {
    snowAPI: SnowAPI
  }
}
