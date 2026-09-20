# Host a Static Website with GitHub Pages

This task demonstrates how to deploy a simple static HTML website using **GitHub Pages**, including customizations like CSS styling, images and an About Me page with a full-page background.

## Objective
Deploy a simple HTML website using GitHub Pages and make it live.

## Tools Used
- GitHub
- GitHub Pages
- HTML, CSS (basic styling)

## Project Structure

    my-website/
     │── index.html # Home page
     │── about.html # About Me page
     │── style.css # Optional CSS file
     └── images/
     └── Space-Background-Images-1024x682.jpg # Background image

# Steps

## 1. Create GitHub Repository

### Initialize a new repository locally
git init

### Add files
git add .

### Commit files
git commit -m `"Initial commit: Add index.html, about.html, images"`

### Add remote origin (replace with your repo URL)
git remote add origin `https://github.com/<username>/my-website.git`

### Push to GitHub
git branch -M main

git push -u origin main

## 2. Enable GitHub Pages
Go to `GitHub repository → Settings → Pages`

Under Source, select:

Branch: `main`

Folder: `/ (root)`

Click Save.

GitHub will provide a live website link like:
`https://<username>.github.io/my-website/`

## 3. Add Homepage (index.html)
Example content:

    html
    
    <h1>Welcome to My Website!</h1>
    <p>This is a simple static website hosted on GitHub Pages.</p>
    <a href="about.html">About Page</a>
    
Optional: Add CSS for styling and images.

## 4. Add About Page (about.html)
  Example content with full-page background image:
    
    html
    
    <div class="hero">
      <div class="hero-content">
        <h1>About Me</h1>
        <p>I am a tech enthusiast who loves building projects and exploring new technologies.</p>
        <p>Email: <a href="mailto:email@example.com" class="email-link">email@example.com</a></p>
      </div>
    </div>

## 5. Add Images and CSS
Place images in images/ folder.

Link CSS in HTML:

`html`
`<link rel="stylesheet" href="style.css">`

## 6. Commit and Push Changes
git add .
git commit -m "Add about page, background image, and CSS styling"
git push

## 7. Access Live Website
 * Visit the link provided in GitHub Pages settings.

 * Both index.html and about.html should work.

 * Images and CSS customizations should be visible.

# Features Implemented
 * Static HTML website hosted on GitHub Pages.

 * Full-page background image on About Me page.

 * Navigation from index page to About Me page.

 * CSS styling for text readability and highlights (email link highlighted).

# Summary
A simple static website hosted on GitHub Pages, featuring a homepage with a full-page background image, an About Me page with personal information and contact details and basic CSS styling for readability and layout.
