#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const postcss = require('postcss');
const autoprefixer = require('autoprefixer');
const cssnano = require('cssnano');

// Define CSS files to build (relative to project root)
const cssFiles = [
  'styles/main.css',
  'styles/hero.css',
  'styles/pricing.css',
  'styles/admin.css'
];

// Get project root (parent of scripts directory)
const projectRoot = path.join(__dirname, '..');

// Create dist directory if it doesn't exist
const distDir = path.join(projectRoot, 'dist', 'public');
const distStylesDir = path.join(distDir, 'assets');

if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}
if (!fs.existsSync(distStylesDir)) {
  fs.mkdirSync(distStylesDir, { recursive: true });
}

// Process CSS files
(async () => {
  try {
    // Concatenate CSS files
    let concatenatedCss = '';
    for (const file of cssFiles) {
      const filePath = path.join(projectRoot, file);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        concatenatedCss += content + '\n';
      }
    }

    // Process with PostCSS (autoprefixer + cssnano for minification)
    const result = await postcss([autoprefixer(), cssnano()]).process(concatenatedCss, {
      from: undefined
    });

    // Write minified CSS to dist
    const outputPath = path.join(distStylesDir, 'styles.min.css');
    fs.writeFileSync(outputPath, result.css, 'utf-8');
    console.log(`✓ Built ${outputPath}`);

    // Also write unminified for source maps
    const sourceMapPath = path.join(distStylesDir, 'styles.css');
    fs.writeFileSync(sourceMapPath, concatenatedCss, 'utf-8');
    console.log(`✓ Built ${sourceMapPath}`);

    // Copy public HTML files to dist
    const publicDir = path.join(projectRoot, 'public');
    const files = fs.readdirSync(publicDir);

    for (const file of files) {
      if (file.endsWith('.html')) {
        const filePath = path.join(publicDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        
        // Replace stylesheet references
        let updatedContent = content
          .replace(/href="\/styles\.css"/g, 'href="/assets/styles.min.css"')
          .replace(/href="\/global\.css"/g, 'href="/assets/styles.min.css"');
        
        const outputFile = path.join(distDir, file);
        fs.writeFileSync(outputFile, updatedContent, 'utf-8');
        console.log(`✓ Copied ${file}`);
      }
    }

    // Copy assets
    const assetDirs = ['assets', 'uploads', 'reports'];
    for (const dir of assetDirs) {
      const srcDir = path.join(publicDir, dir);
      const destDir = path.join(distDir, dir);
      
      if (fs.existsSync(srcDir)) {
        copyRecursiveSync(srcDir, destDir);
        console.log(`✓ Copied ${dir}/`);
      }
    }

    console.log('\n✓ Build complete! Output in ./dist/public/');
  } catch (err) {
    console.error('Build error:', err);
    process.exit(1);
  }
})();

// Helper function to recursively copy directories
function copyRecursiveSync(src, dest) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  
  const items = fs.readdirSync(src);
  for (const item of items) {
    const srcPath = path.join(src, item);
    const destPath = path.join(dest, item);
    
    if (fs.statSync(srcPath).isDirectory()) {
      copyRecursiveSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
