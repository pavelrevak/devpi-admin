import warnings

# Pyramid 2.1 imports pkg_resources at module load time and triggers a
# setuptools deprecation warning. Silence it so test output stays clean.
warnings.filterwarnings(
    "ignore", category=UserWarning, module="pyramid.path")
warnings.filterwarnings(
    "ignore", category=DeprecationWarning, module="pkg_resources")
