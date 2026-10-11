import * as React from "react";
import { cn } from "../../lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn("h-9 w-full rounded-md border border-rule bg-surface px-3 text-sm placeholder:text-dim focus-visible:outline-2 focus-visible:outline-phosphor", className)}
    {...props}
  />
));
Input.displayName = "Input";
