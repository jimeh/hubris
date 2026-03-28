/* Auto-generated from monaco-editor language contributions — do not edit. */
/* Run: cd frontend && bun run generate:monaco-languages */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonacoFilenameAssociation {
    pub filename: &'static str,
    pub language: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonacoExtensionAssociation {
    pub suffix: &'static str,
    pub language: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonacoFirstLineRule {
    NodeShebang,
    PythonShebang,
    XmlLike,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MonacoFirstLineAssociation {
    pub rule: MonacoFirstLineRule,
    pub language: &'static str,
}

pub const MONACO_FILENAME_ASSOCIATIONS: &[MonacoFilenameAssociation] = &[
    MonacoFilenameAssociation {
        filename: ".editorconfig",
        language: "ini",
    },
    MonacoFilenameAssociation {
        filename: ".gitattributes",
        language: "ini",
    },
    MonacoFilenameAssociation {
        filename: ".gitconfig",
        language: "ini",
    },
    MonacoFilenameAssociation {
        filename: "config",
        language: "ini",
    },
    MonacoFilenameAssociation {
        filename: "dockerfile",
        language: "dockerfile",
    },
    MonacoFilenameAssociation {
        filename: "gemfile",
        language: "ruby",
    },
    MonacoFilenameAssociation {
        filename: "jakefile",
        language: "javascript",
    },
    MonacoFilenameAssociation {
        filename: "rakefile",
        language: "ruby",
    },
];

pub const MONACO_EXTENSION_ASSOCIATIONS: &[MonacoExtensionAssociation] = &[
    MonacoExtensionAssociation {
        suffix: ".html.liquid",
        language: "liquid",
    },
    MonacoExtensionAssociation {
        suffix: ".properties",
        language: "ini",
    },
    MonacoExtensionAssociation {
        suffix: ".handlebars",
        language: "handlebars",
    },
    MonacoExtensionAssociation {
        suffix: ".dockerfile",
        language: "dockerfile",
    },
    MonacoExtensionAssociation {
        suffix: ".gitconfig",
        language: "ini",
    },
    MonacoExtensionAssociation {
        suffix: ".eslintrc",
        language: "json",
    },
    MonacoExtensionAssociation {
        suffix: ".jshintrc",
        language: "json",
    },
    MonacoExtensionAssociation {
        suffix: ".rhistory",
        language: "r",
    },
    MonacoExtensionAssociation {
        suffix: ".rprofile",
        language: "r",
    },
    MonacoExtensionAssociation {
        suffix: ".markdown",
        language: "markdown",
    },
    MonacoExtensionAssociation {
        suffix: ".fsscript",
        language: "fsharp",
    },
    MonacoExtensionAssociation {
        suffix: ".babelrc",
        language: "json",
    },
    MonacoExtensionAssociation {
        suffix: ".bowerrc",
        language: "json",
    },
    MonacoExtensionAssociation {
        suffix: ".targets",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".gemspec",
        language: "ruby",
    },
    MonacoExtensionAssociation {
        suffix: ".graphql",
        language: "graphql",
    },
    MonacoExtensionAssociation {
        suffix: ".jscsrc",
        language: "json",
    },
    MonacoExtensionAssociation {
        suffix: ".config",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".csproj",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".iecplc",
        language: "st",
    },
    MonacoExtensionAssociation {
        suffix: ".lc3lib",
        language: "st",
    },
    MonacoExtensionAssociation {
        suffix: ".cshtml",
        language: "razor",
    },
    MonacoExtensionAssociation {
        suffix: ".mdtext",
        language: "markdown",
    },
    MonacoExtensionAssociation {
        suffix: ".liquid",
        language: "liquid",
    },
    MonacoExtensionAssociation {
        suffix: ".tfvars",
        language: "hcl",
    },
    MonacoExtensionAssociation {
        suffix: ".cypher",
        language: "cypher",
    },
    MonacoExtensionAssociation {
        suffix: ".coffee",
        language: "coffeescript",
    },
    MonacoExtensionAssociation {
        suffix: ".props",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".swift",
        language: "swift",
    },
    MonacoExtensionAssociation {
        suffix: ".iecst",
        language: "st",
    },
    MonacoExtensionAssociation {
        suffix: ".tcdut",
        language: "st",
    },
    MonacoExtensionAssociation {
        suffix: ".tcgvl",
        language: "st",
    },
    MonacoExtensionAssociation {
        suffix: ".tcpou",
        language: "st",
    },
    MonacoExtensionAssociation {
        suffix: ".scala",
        language: "scala",
    },
    MonacoExtensionAssociation {
        suffix: ".redis",
        language: "redis",
    },
    MonacoExtensionAssociation {
        suffix: ".proto",
        language: "proto",
    },
    MonacoExtensionAssociation {
        suffix: ".phtml",
        language: "php",
    },
    MonacoExtensionAssociation {
        suffix: ".msdax",
        language: "msdax",
    },
    MonacoExtensionAssociation {
        suffix: ".mdown",
        language: "markdown",
    },
    MonacoExtensionAssociation {
        suffix: ".mdtxt",
        language: "markdown",
    },
    MonacoExtensionAssociation {
        suffix: ".jshtm",
        language: "html",
    },
    MonacoExtensionAssociation {
        suffix: ".shtml",
        language: "html",
    },
    MonacoExtensionAssociation {
        suffix: ".xhtml",
        language: "html",
    },
    MonacoExtensionAssociation {
        suffix: ".mligo",
        language: "cameligo",
    },
    MonacoExtensionAssociation {
        suffix: ".bicep",
        language: "bicep",
    },
    MonacoExtensionAssociation {
        suffix: ".azcli",
        language: "azcli",
    },
    MonacoExtensionAssociation {
        suffix: ".json",
        language: "json",
    },
    MonacoExtensionAssociation {
        suffix: ".yaml",
        language: "yaml",
    },
    MonacoExtensionAssociation {
        suffix: ".ascx",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".svgz",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".xaml",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".xslt",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".wgsl",
        language: "wgsl",
    },
    MonacoExtensionAssociation {
        suffix: ".twig",
        language: "twig",
    },
    MonacoExtensionAssociation {
        suffix: ".tcio",
        language: "st",
    },
    MonacoExtensionAssociation {
        suffix: ".bash",
        language: "shell",
    },
    MonacoExtensionAssociation {
        suffix: ".scss",
        language: "scss",
    },
    MonacoExtensionAssociation {
        suffix: ".rlib",
        language: "rust",
    },
    MonacoExtensionAssociation {
        suffix: ".gypi",
        language: "python",
    },
    MonacoExtensionAssociation {
        suffix: ".jade",
        language: "pug",
    },
    MonacoExtensionAssociation {
        suffix: ".psd1",
        language: "powershell",
    },
    MonacoExtensionAssociation {
        suffix: ".psm1",
        language: "powershell",
    },
    MonacoExtensionAssociation {
        suffix: ".dats",
        language: "postiats",
    },
    MonacoExtensionAssociation {
        suffix: ".hats",
        language: "postiats",
    },
    MonacoExtensionAssociation {
        suffix: ".sats",
        language: "postiats",
    },
    MonacoExtensionAssociation {
        suffix: ".php4",
        language: "php",
    },
    MonacoExtensionAssociation {
        suffix: ".php5",
        language: "php",
    },
    MonacoExtensionAssociation {
        suffix: ".ligo",
        language: "pascaligo",
    },
    MonacoExtensionAssociation {
        suffix: ".mdwn",
        language: "markdown",
    },
    MonacoExtensionAssociation {
        suffix: ".mkdn",
        language: "markdown",
    },
    MonacoExtensionAssociation {
        suffix: ".less",
        language: "less",
    },
    MonacoExtensionAssociation {
        suffix: ".java",
        language: "java",
    },
    MonacoExtensionAssociation {
        suffix: ".aspx",
        language: "html",
    },
    MonacoExtensionAssociation {
        suffix: ".html",
        language: "html",
    },
    MonacoExtensionAssociation {
        suffix: ".mdoc",
        language: "html",
    },
    MonacoExtensionAssociation {
        suffix: ".ftlh",
        language: "freemarker2",
    },
    MonacoExtensionAssociation {
        suffix: ".ftlx",
        language: "freemarker2",
    },
    MonacoExtensionAssociation {
        suffix: ".flow",
        language: "flow9",
    },
    MonacoExtensionAssociation {
        suffix: ".dart",
        language: "dart",
    },
    MonacoExtensionAssociation {
        suffix: ".cake",
        language: "csharp",
    },
    MonacoExtensionAssociation {
        suffix: ".cljc",
        language: "clojure",
    },
    MonacoExtensionAssociation {
        suffix: ".cljs",
        language: "clojure",
    },
    MonacoExtensionAssociation {
        suffix: ".abap",
        language: "abap",
    },
    MonacoExtensionAssociation {
        suffix: ".har",
        language: "json",
    },
    MonacoExtensionAssociation {
        suffix: ".yml",
        language: "yaml",
    },
    MonacoExtensionAssociation {
        suffix: ".dtd",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".opf",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".svg",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".wxi",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".wxl",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".wxs",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".xml",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".xsd",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".xsl",
        language: "xml",
    },
    MonacoExtensionAssociation {
        suffix: ".tsp",
        language: "typespec",
    },
    MonacoExtensionAssociation {
        suffix: ".cts",
        language: "typescript",
    },
    MonacoExtensionAssociation {
        suffix: ".mts",
        language: "typescript",
    },
    MonacoExtensionAssociation {
        suffix: ".tsx",
        language: "typescript",
    },
    MonacoExtensionAssociation {
        suffix: ".tcl",
        language: "tcl",
    },
    MonacoExtensionAssociation {
        suffix: ".svh",
        language: "systemverilog",
    },
    MonacoExtensionAssociation {
        suffix: ".sql",
        language: "sql",
    },
    MonacoExtensionAssociation {
        suffix: ".aes",
        language: "aes",
    },
    MonacoExtensionAssociation {
        suffix: ".sol",
        language: "sol",
    },
    MonacoExtensionAssociation {
        suffix: ".rkt",
        language: "scheme",
    },
    MonacoExtensionAssociation {
        suffix: ".sch",
        language: "scheme",
    },
    MonacoExtensionAssociation {
        suffix: ".scm",
        language: "scheme",
    },
    MonacoExtensionAssociation {
        suffix: ".sbt",
        language: "scala",
    },
    MonacoExtensionAssociation {
        suffix: ".rbx",
        language: "ruby",
    },
    MonacoExtensionAssociation {
        suffix: ".rjs",
        language: "ruby",
    },
    MonacoExtensionAssociation {
        suffix: ".rst",
        language: "restructuredtext",
    },
    MonacoExtensionAssociation {
        suffix: ".rmd",
        language: "r",
    },
    MonacoExtensionAssociation {
        suffix: ".cpy",
        language: "python",
    },
    MonacoExtensionAssociation {
        suffix: ".gyp",
        language: "python",
    },
    MonacoExtensionAssociation {
        suffix: ".pyw",
        language: "python",
    },
    MonacoExtensionAssociation {
        suffix: ".rpy",
        language: "python",
    },
    MonacoExtensionAssociation {
        suffix: ".pug",
        language: "pug",
    },
    MonacoExtensionAssociation {
        suffix: ".ps1",
        language: "powershell",
    },
    MonacoExtensionAssociation {
        suffix: ".pqm",
        language: "powerquery",
    },
    MonacoExtensionAssociation {
        suffix: ".pla",
        language: "pla",
    },
    MonacoExtensionAssociation {
        suffix: ".ctp",
        language: "php",
    },
    MonacoExtensionAssociation {
        suffix: ".php",
        language: "php",
    },
    MonacoExtensionAssociation {
        suffix: ".pas",
        language: "pascal",
    },
    MonacoExtensionAssociation {
        suffix: ".dax",
        language: "msdax",
    },
    MonacoExtensionAssociation {
        suffix: ".mdx",
        language: "mdx",
    },
    MonacoExtensionAssociation {
        suffix: ".mkd",
        language: "markdown",
    },
    MonacoExtensionAssociation {
        suffix: ".lua",
        language: "lua",
    },
    MonacoExtensionAssociation {
        suffix: ".lex",
        language: "lexon",
    },
    MonacoExtensionAssociation {
        suffix: ".kts",
        language: "kotlin",
    },
    MonacoExtensionAssociation {
        suffix: ".cjs",
        language: "javascript",
    },
    MonacoExtensionAssociation {
        suffix: ".es6",
        language: "javascript",
    },
    MonacoExtensionAssociation {
        suffix: ".jsx",
        language: "javascript",
    },
    MonacoExtensionAssociation {
        suffix: ".mjs",
        language: "javascript",
    },
    MonacoExtensionAssociation {
        suffix: ".jav",
        language: "java",
    },
    MonacoExtensionAssociation {
        suffix: ".ini",
        language: "ini",
    },
    MonacoExtensionAssociation {
        suffix: ".asp",
        language: "html",
    },
    MonacoExtensionAssociation {
        suffix: ".htm",
        language: "html",
    },
    MonacoExtensionAssociation {
        suffix: ".jsp",
        language: "html",
    },
    MonacoExtensionAssociation {
        suffix: ".hcl",
        language: "hcl",
    },
    MonacoExtensionAssociation {
        suffix: ".hbs",
        language: "handlebars",
    },
    MonacoExtensionAssociation {
        suffix: ".gql",
        language: "graphql",
    },
    MonacoExtensionAssociation {
        suffix: ".ftl",
        language: "freemarker2",
    },
    MonacoExtensionAssociation {
        suffix: ".fsi",
        language: "fsharp",
    },
    MonacoExtensionAssociation {
        suffix: ".fsx",
        language: "fsharp",
    },
    MonacoExtensionAssociation {
        suffix: ".mli",
        language: "fsharp",
    },
    MonacoExtensionAssociation {
        suffix: ".exs",
        language: "elixir",
    },
    MonacoExtensionAssociation {
        suffix: ".ecl",
        language: "ecl",
    },
    MonacoExtensionAssociation {
        suffix: ".cyp",
        language: "cypher",
    },
    MonacoExtensionAssociation {
        suffix: ".css",
        language: "css",
    },
    MonacoExtensionAssociation {
        suffix: ".csp",
        language: "csp",
    },
    MonacoExtensionAssociation {
        suffix: ".csx",
        language: "csharp",
    },
    MonacoExtensionAssociation {
        suffix: ".cpp",
        language: "cpp",
    },
    MonacoExtensionAssociation {
        suffix: ".cxx",
        language: "cpp",
    },
    MonacoExtensionAssociation {
        suffix: ".hpp",
        language: "cpp",
    },
    MonacoExtensionAssociation {
        suffix: ".hxx",
        language: "cpp",
    },
    MonacoExtensionAssociation {
        suffix: ".clj",
        language: "clojure",
    },
    MonacoExtensionAssociation {
        suffix: ".edn",
        language: "clojure",
    },
    MonacoExtensionAssociation {
        suffix: ".bat",
        language: "bat",
    },
    MonacoExtensionAssociation {
        suffix: ".cmd",
        language: "bat",
    },
    MonacoExtensionAssociation {
        suffix: ".cls",
        language: "apex",
    },
    MonacoExtensionAssociation {
        suffix: ".vb",
        language: "vb",
    },
    MonacoExtensionAssociation {
        suffix: ".ts",
        language: "typescript",
    },
    MonacoExtensionAssociation {
        suffix: ".vh",
        language: "verilog",
    },
    MonacoExtensionAssociation {
        suffix: ".sv",
        language: "systemverilog",
    },
    MonacoExtensionAssociation {
        suffix: ".st",
        language: "st",
    },
    MonacoExtensionAssociation {
        suffix: ".rq",
        language: "sparql",
    },
    MonacoExtensionAssociation {
        suffix: ".sh",
        language: "shell",
    },
    MonacoExtensionAssociation {
        suffix: ".ss",
        language: "scheme",
    },
    MonacoExtensionAssociation {
        suffix: ".sc",
        language: "scala",
    },
    MonacoExtensionAssociation {
        suffix: ".sb",
        language: "sb",
    },
    MonacoExtensionAssociation {
        suffix: ".rs",
        language: "rust",
    },
    MonacoExtensionAssociation {
        suffix: ".pp",
        language: "ruby",
    },
    MonacoExtensionAssociation {
        suffix: ".rb",
        language: "ruby",
    },
    MonacoExtensionAssociation {
        suffix: ".rt",
        language: "r",
    },
    MonacoExtensionAssociation {
        suffix: ".qs",
        language: "qsharp",
    },
    MonacoExtensionAssociation {
        suffix: ".py",
        language: "python",
    },
    MonacoExtensionAssociation {
        suffix: ".pq",
        language: "powerquery",
    },
    MonacoExtensionAssociation {
        suffix: ".pl",
        language: "perl",
    },
    MonacoExtensionAssociation {
        suffix: ".pm",
        language: "perl",
    },
    MonacoExtensionAssociation {
        suffix: ".md",
        language: "markdown",
    },
    MonacoExtensionAssociation {
        suffix: ".i3",
        language: "m3",
    },
    MonacoExtensionAssociation {
        suffix: ".ig",
        language: "m3",
    },
    MonacoExtensionAssociation {
        suffix: ".m3",
        language: "m3",
    },
    MonacoExtensionAssociation {
        suffix: ".mg",
        language: "m3",
    },
    MonacoExtensionAssociation {
        suffix: ".kt",
        language: "kotlin",
    },
    MonacoExtensionAssociation {
        suffix: ".jl",
        language: "julia",
    },
    MonacoExtensionAssociation {
        suffix: ".js",
        language: "javascript",
    },
    MonacoExtensionAssociation {
        suffix: ".tf",
        language: "hcl",
    },
    MonacoExtensionAssociation {
        suffix: ".go",
        language: "go",
    },
    MonacoExtensionAssociation {
        suffix: ".fs",
        language: "fsharp",
    },
    MonacoExtensionAssociation {
        suffix: ".ml",
        language: "fsharp",
    },
    MonacoExtensionAssociation {
        suffix: ".ex",
        language: "elixir",
    },
    MonacoExtensionAssociation {
        suffix: ".cs",
        language: "csharp",
    },
    MonacoExtensionAssociation {
        suffix: ".cc",
        language: "cpp",
    },
    MonacoExtensionAssociation {
        suffix: ".hh",
        language: "cpp",
    },
    MonacoExtensionAssociation {
        suffix: ".v",
        language: "verilog",
    },
    MonacoExtensionAssociation {
        suffix: ".r",
        language: "r",
    },
    MonacoExtensionAssociation {
        suffix: ".p",
        language: "pascal",
    },
    MonacoExtensionAssociation {
        suffix: ".m",
        language: "objective-c",
    },
    MonacoExtensionAssociation {
        suffix: ".s",
        language: "mips",
    },
    MonacoExtensionAssociation {
        suffix: ".c",
        language: "c",
    },
    MonacoExtensionAssociation {
        suffix: ".h",
        language: "c",
    },
];

pub const MONACO_FIRST_LINE_ASSOCIATIONS: &[MonacoFirstLineAssociation] = &[
    MonacoFirstLineAssociation {
        rule: MonacoFirstLineRule::NodeShebang,
        language: "javascript",
    },
    MonacoFirstLineAssociation {
        rule: MonacoFirstLineRule::PythonShebang,
        language: "python",
    },
    MonacoFirstLineAssociation {
        rule: MonacoFirstLineRule::XmlLike,
        language: "xml",
    },
];
