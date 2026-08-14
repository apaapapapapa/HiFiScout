/**
 * User-facing listing-change semantics consumed by the generic product write path.
 *
 * Concrete shops choose a policy at the crawler composition boundary. Persistence only evaluates
 * the supplied field-level policy and never branches on a shop identity.
 */
export interface ProductActivityPolicy {
  readonly model: boolean;
  readonly title: boolean;
  readonly condition: boolean;
  readonly price: boolean;
  readonly stock: boolean;
  readonly reactivation: boolean;
}

/** Existing behavior for shops that do not opt into narrower activity semantics. */
export const DEFAULT_PRODUCT_ACTIVITY_POLICY: Readonly<ProductActivityPolicy> = Object.freeze({
  model: true,
  title: true,
  condition: true,
  price: true,
  stock: true,
  reactivation: true,
});
