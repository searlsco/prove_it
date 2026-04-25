# @davemo/pi-prove-it

Pi package for prove_it's harness-neutral methodology enforcement.

This package bundles:

- the Pi extension entrypoint;
- the prove_it runtime files needed by the Pi adapter;
- the shipped prove_it skills.

Install with:

```bash
pi install npm:@davemo/pi-prove-it
```

During repository development, keep vendored runtime and skills synchronized with:

```bash
node tools/sync-pi-package.js
```
