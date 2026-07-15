import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { RetirementNotice } from "@/components/retirement-notice"

describe("RetirementNotice", () => {
  it("renders nothing on the Windows edition (no retirement banner)", () => {
    const { container } = render(<RetirementNotice />)
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText("OpenUsage Has Moved")).not.toBeInTheDocument()
  })
})
