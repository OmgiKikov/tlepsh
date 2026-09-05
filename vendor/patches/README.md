# Pi vendor patches

AHDE consumes the checked-in Pi package tarballs. The patch in this directory
records the small host-policy extension that was used to build the coding-agent
tarball, without making the parent repository depend on an unpublished commit
inside the embedded vendor/pi-mono checkout.

To reproduce the tarball from the pinned Pi checkout:

    git submodule update --init vendor/pi-mono
    git -C vendor/pi-mono apply ../patches/pi-coding-agent-host-policy.patch
    npm run vendor:build
    npm run vendor:pack

The submodule URL is recorded in `.gitmodules`; the parent repository pins its
commit. Run the patch step once on a clean pinned checkout. Normal installation
uses the already checked-in tarballs and does not need the submodule or a vendor
build. Review and commit rebuilt tarballs together with any pin or patch change.

The patch adds host-owned built-in command filtering, extension-command
precedence, bash-input policy, resume-hint control, and a host override for
the missing-model startup notice (`modelFallbackHint`), together with upstream
tests for those seams.
