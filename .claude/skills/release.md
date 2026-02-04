# /release

Release a new version of prove_it.

## Usage

```
/release
```

## Instructions

<release>
To release prove_it:

1. **Bump version in package.json** - increment the patch version (e.g., 0.0.17 -> 0.0.18)

2. **Commit and tag**:
```bash
git add package.json
git commit -m "v0.0.X"
git tag v0.0.X
git push && git push --tags
```

3. **Monitor GitHub Actions** - wait for both to complete successfully:
```bash
gh run list --repo searlsco/prove_it --limit 1
gh run list --repo searlsco/homebrew-tap --limit 1
```

4. **Verify the release**:
```bash
brew update
brew reinstall searlsco/tap/prove_it
prove_it --version
```

Report the version number and confirmation that the brew install succeeded.
</release>
