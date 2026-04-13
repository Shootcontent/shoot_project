# SHOOT. Studios CT — Website

## Project Structure
```
/
├── index.html              ← Main site (open this to view locally)
├── assets/
│   └── images/
│       ├── logo.png        ← SHOOT. Studios logo
│       └── the-curve.jpg  ← The Curve studio photo
└── api/
    └── send_booking.php    ← Email backend (for cPanel hosting)
```

## Viewing Locally
Just open `index.html` in your browser. No server needed.

Note: The booking form uses Formspree (https://formspree.io/f/xbdpbqra)
and sends emails to hello@shootstudios.co.za — this works live even locally.

## Deploying to cPanel (shootstudios.co.za)
Upload these files to public_html/:
1. `index.html`
2. `assets/images/logo.png`
3. `assets/images/the-curve.jpg`
4. `api/send_booking.php` (optional — form uses Formspree instead)

## What Was Fixed
1. ✅ Booking form sends to hello@shootstudios.co.za via Formspree
2. ✅ Pricing card buttons are perfectly aligned (flex layout)
3. ✅ Real SHOOT. logo displayed in nav and footer
4. ✅ Real Curve studio photo displayed
5. ✅ Montserrat font throughout
6. ✅ Full booking modal with pricing calculator

## Email Setup
Booking submissions go through Formspree (xbdpbqra) to hello@shootstudios.co.za.
Check your email at: webmail.shootstudios.co.za
Credentials: hello@shootstudios.co.za / Shoot2024
