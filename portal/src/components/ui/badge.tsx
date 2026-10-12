import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

// Status chips: the light tints of the two brand colours, and a neutral one.
const badgeVariants = cva("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", {
  variants: {
    tone: {
      phosphor: "bg-phosphor-chip text-phosphor",
      amber: "bg-amber-chip text-amber",
      neutral: "bg-neutral-chip text-dim"
    }
  },
  defaultVariants: { tone: "neutral" }
});

/** `moving` adds a breathing dot: something is under way and the page will update. */
export function Badge({ className, tone, moving, children, ...props }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants> & { moving?: boolean }) {
  return (
    <span className={cn(badgeVariants({ tone }), moving ? "gap-1.5" : null, className)} {...props}>
      {moving ? <span aria-hidden="true" className="sealeye-breathe size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}
