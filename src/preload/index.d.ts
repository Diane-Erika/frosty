import type { SnowAPI } from "../shared/types"

declare global {
  interface Window {
    snowAPI: SnowAPI
  }
}
