<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, OPTIONS');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { http_response_code(200); exit; }
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success'=>false,'message'=>'Method not allowed']); exit;
}

$firstName = htmlspecialchars(trim($_POST['firstName'] ?? ''));
$lastName  = htmlspecialchars(trim($_POST['lastName'] ?? ''));
$email     = filter_var(trim($_POST['email'] ?? ''), FILTER_SANITIZE_EMAIL);
$phone     = htmlspecialchars(trim($_POST['phone'] ?? ''));
$service   = htmlspecialchars(trim($_POST['service'] ?? ''));
$duration  = htmlspecialchars(trim($_POST['duration'] ?? ''));
$date      = htmlspecialchars(trim($_POST['date'] ?? ''));
$message   = htmlspecialchars(trim($_POST['message'] ?? ''));

if (!$firstName || !$email) {
    echo json_encode(['success'=>false,'message'=>'Missing required fields']); exit;
}

$to      = 'hello@shootstudios.co.za';
$subject = 'New Booking Request - ' . $firstName . ' ' . $lastName;
$body    = "NEW BOOKING REQUEST\n==================\n\n"
         . "Name:     $firstName $lastName\n"
         . "Email:    $email\n"
         . "Phone:    $phone\n\n"
         . "Studio:   $service\n"
         . "Duration: $duration\n"
         . "Date:     $date\n\n"
         . "Details:\n$message";

$headers = "From: hello@shootstudios.co.za\r\nReply-To: $email\r\n";
$sent = mail($to, $subject, $body, $headers, "-fhello@shootstudios.co.za");
echo json_encode(['success' => (bool)$sent, 'message' => $sent ? 'Sent!' : 'Failed']);
